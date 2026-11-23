import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tokens, upsertMemory, explicitRemember, selectMemories, relatedConversations, buildMemoryBlock, parseExtraction, pendingSummaryRange, looksSecret, readPrefs } from '../memory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 纯函数 ----------
test('记忆：分词、去重合并、敏感信息过滤', () => {
  assert.ok(tokens('我喜欢用 TypeScript').has('typescript'));
  assert.ok(tokens('前端工程师').has('工程'));
  const db = { memories: {} };
  const a = upsertMemory(db, 'u1', { text: '用户是前端工程师，偏好 TypeScript', kind: 'profile' });
  const b = upsertMemory(db, 'u1', { text: '用户是前端工程师，偏好 TypeScript 和 React' });
  assert.equal(a.id, b.id, '相似内容合并为同一条');
  assert.equal(Object.keys(db.memories).length, 1);
  assert.equal(b.kind, 'profile');
  assert.equal(upsertMemory(db, 'u1', { text: '我的密码是 hunter2hunter2' }), null, '密码不保存');
  assert.equal(upsertMemory(db, 'u1', { text: 'api_key=abcdef123456' }), null);
  assert.ok(looksSecret('sk-abcdefghijklmnopqrstuv'));
  upsertMemory(db, 'u2', { text: '另一个用户的记忆内容' });
  assert.equal(Object.values(db.memories).filter(m => m.userId === 'u2').length, 1);
});

test('记忆：显式“记住”、取回相关记忆、置顶必带、预算封顶', () => {
  assert.equal(explicitRemember('记住：我的项目叫星火'), '我的项目叫星火');
  assert.equal(explicitRemember('请记住 部署在香港服务器'), '部署在香港服务器');
  assert.equal(explicitRemember('你记得吗'), null);
  const db = { memories: {} };
  upsertMemory(db, 'u', { text: '用户的项目叫星火，使用 Postgres 数据库', kind: 'note' });
  upsertMemory(db, 'u', { text: '用户喜欢简洁的中文回答', kind: 'profile' });
  upsertMemory(db, 'u', { text: '用户家里养了一只猫叫团子', kind: 'note' });
  upsertMemory(db, 'u', { text: '回答时必须附带来源', kind: 'note', pinned: true });
  const picked = selectMemories(Object.values(db.memories), '星火的 Postgres 怎么备份').map(m => m.text);
  assert.ok(picked.some(t => t.includes('星火')), '话题相关的被选中');
  assert.ok(picked.some(t => t.includes('简洁')), '偏好类总是带上');
  assert.ok(picked.some(t => t.includes('来源')), '置顶总是带上');
  assert.ok(!picked.some(t => t.includes('团子')), '无关的不带');
  assert.equal(selectMemories(Object.values(db.memories), 'x', { budget: 5 }).length, 0, '超出预算的不放');
});

test('记忆：往期对话关联、提示块、提取解析、摘要范围', () => {
  const conv = (id, title, content, userId = 'u') => ({ id, userId, title, updatedAt: 1, messages: [{ role: 'user', content }, { role: 'assistant', content: 'ok' }] });
  const related = relatedConversations([conv('c1', '星火部署', '星火项目怎么部署到香港服务器'), conv('c2', '菜谱', '红烧肉怎么做'), conv('c3', '别人', '星火项目怎么部署', 'other')], 'cur', 'u', '星火项目部署遇到问题');
  assert.deepEqual(related.map(r => r.item.id), ['c1']);
  assert.equal(buildMemoryBlock({}), '');
  const block = buildMemoryBlock({ memories: [{ text: '用户偏好中文' }], summary: '聊过部署', related });
  assert.match(block, /用户偏好中文/); assert.match(block, /聊过部署/); assert.match(block, /星火部署/);
  assert.deepEqual(parseExtraction('好的：[{"text":"用户用 Go","kind":"profile"},"用户在做游戏项目"]').map(x => x.kind), ['profile', 'note']);
  assert.deepEqual(parseExtraction('没有'), []);
  assert.deepEqual(parseExtraction('[坏的'), []);
  const long = { messages: Array.from({ length: 40 }, () => ({ role: 'user', content: 'x' })) };
  assert.deepEqual(pendingSummaryRange(long, 24), { from: 0, to: 16 });
  assert.equal(pendingSummaryRange({ ...long, summary: { upTo: 14 } }, 24), null, '新增不足一批不重复摘要');
  assert.deepEqual(readPrefs({ memoryPrefs: { auto: false } }), { enabled: true, auto: false, crossChat: true });
});

// ---------- 接口集成 ----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, model, app, base, owner, seen = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-memory-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  model = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw), system = body.messages.find(m => m.role === 'system')?.content || '', last = body.messages.at(-1).content;
      let reply;
      if (last.startsWith('从下面这一轮对话里')) reply = '[{"text":"用户是独立游戏开发者，使用 Lua","kind":"profile"}]';
      else if (last.startsWith('把下面的对话合并进')) reply = '摘要：聊了部署方案';
      else { seen.push({ model: body.model, system }); reply = 'ok'; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { total_tokens: 2 } }));
    });
  });
  const modelPort = await listen(model);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'test-model', MODEL_API_KEY: 'k', MODEL_CONTEXT_MESSAGES: '4' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('exit ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(ADMIN) });
  owner = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); model?.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
async function call(auth, p, method = 'GET', body) {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } return null; };

test('记忆：手动增删改、开关、权限隔离', async () => {
  const add = await call(owner, '/api/memories', 'POST', { text: '我的项目叫星火', pinned: true });
  assert.equal(add.status, 201);
  assert.equal((await call(owner, '/api/memories', 'POST', { text: '密码是 abcdefgh12345' })).status, 400);
  assert.equal((await call(owner, '/api/memories', 'POST', { text: 'x' })).status, 400);
  const id = add.data.memory.id;
  assert.equal((await call(owner, '/api/memories/' + id, 'PATCH', { text: '我的项目叫星火 2 号', pinned: false })).data.memory.pinned, false);
  const other = await call(owner, '/api/admin/members', 'POST', { email: 'm@example.com', password: 'member-password-12345' });
  assert.equal(other.status < 300, true);
  const lr = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'm@example.com', password: 'member-password-12345' }) });
  const mine = { cookie: lr.headers.get('set-cookie').split(';')[0], csrf: (await lr.json()).csrfToken };
  assert.equal((await call(mine, '/api/memories')).data.memories.length, 0, '别人看不到');
  assert.equal((await call(mine, '/api/memories/' + id, 'DELETE')).status, 404);
  assert.equal((await call(owner, '/api/memory/prefs', 'PUT', { crossChat: false })).data.prefs.crossChat, false);
  await call(owner, '/api/memory/prefs', 'PUT', { crossChat: true });
  assert.equal((await call(owner, '/api/memories/' + id, 'DELETE')).status, 200);
});

test('记忆：自动提取 → 新对话带上；中途换模型、对话摘要不丢', async () => {
  await call(owner, '/api/memories', 'DELETE');
  const c1 = (await call(owner, '/api/conversations', 'POST', {})).data.conversation;
  await call(owner, '/api/chat', 'POST', { conversation_id: c1.id, message: '我是独立游戏开发者，主要用 Lua 写游戏' });
  const learned = await until(async () => (await call(owner, '/api/memories')).data.memories.find(m => m.text.includes('Lua')));
  assert.ok(learned, '后台自动提取了记忆');

  // 全新对话：系统提示词里带着刚才学到的内容
  seen = [];
  const c2 = (await call(owner, '/api/conversations', 'POST', {})).data.conversation;
  const r = await call(owner, '/api/chat', 'POST', { conversation_id: c2.id, message: '帮我看看怎么优化' });
  assert.ok(r.data.memory_used >= 1);
  assert.match(seen.at(-1).system, /独立游戏开发者/);

  // 显式“记住”立刻生效
  await call(owner, '/api/chat', 'POST', { conversation_id: c2.id, message: '记住：发布渠道是 TapTap' });
  assert.ok((await call(owner, '/api/memories')).data.memories.some(m => m.text === '发布渠道是 TapTap' && m.pinned));

  // 中途换模型：对话不变，下一条请求用新模型，记忆仍在
  assert.equal((await call(owner, '/api/conversations/' + c2.id, 'PATCH', { model: 'nope/none' })).status, 400);
  assert.equal((await call(owner, '/api/conversations/' + c2.id, 'PATCH', { model: 'test-model' })).status, 200);
  seen = [];
  await call(owner, '/api/chat', 'POST', { conversation_id: c2.id, message: '继续说发布渠道的事' });
  assert.match(seen.at(-1).system, /TapTap/);

  // 超出上下文窗口（4 条）后生成摘要，并注入后续请求
  for (let i = 0; i < 4; i++) await call(owner, '/api/chat', 'POST', { conversation_id: c2.id, message: '第 ' + i + ' 个问题，随便聊聊部署' });
  assert.ok(await until(async () => seen.length && (await call(owner, '/api/chat', 'POST', { conversation_id: c2.id, message: '再确认一下部署' })) && /摘要：聊了部署方案/.test(seen.at(-1).system)), '摘要被注入');
});

test('记忆：关闭后不注入也不记录', async () => {
  await call(owner, '/api/memories', 'DELETE');
  await call(owner, '/api/memories', 'POST', { text: '用户喜欢蓝色界面', pinned: true });
  await call(owner, '/api/memory/prefs', 'PUT', { enabled: false });
  const c = (await call(owner, '/api/conversations', 'POST', {})).data.conversation;
  seen = [];
  const r = await call(owner, '/api/chat', 'POST', { conversation_id: c.id, message: '记住：这条不该被保存哦' });
  assert.equal(r.data.memory_used, 0);
  assert.doesNotMatch(seen.at(-1).system, /蓝色/);
  assert.equal((await call(owner, '/api/memories')).data.memories.length, 1);
  await call(owner, '/api/memory/prefs', 'PUT', { enabled: true });
});

test('机器人记忆：按会话隔离、不带主人的个人记忆、可开关/查看/删除', async () => {
  await call(owner, '/api/memories', 'DELETE');
  await call(owner, '/api/memories', 'POST', { text: '主人的私人信息：住在北京朝阳区', pinned: true });
  const created = await call(owner, '/api/bots', 'POST', { name: '客服' });
  assert.equal(created.status, 201);
  const { bot, token } = created.data;
  const ask = (session, text) => fetch(base + '/bot/' + bot.id, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, session }) }).then(r => r.json());

  seen = [];
  assert.ok((await ask('用户A', '我是独立游戏开发者，主要用 Lua 写游戏')).reply);
  assert.doesNotMatch(seen.at(-1).system, /北京朝阳/, '机器人绝不带上主人的个人记忆');
  assert.ok(await until(async () => (await call(owner, `/api/bots/${bot.id}/memories`)).data.memories.find(m => m.session === '用户A' && /Lua/.test(m.text))), '后台提取出该会话的记忆');

  seen = [];
  const again = await ask('用户A', '帮我优化一下游戏代码');
  assert.ok(again.memory_used >= 1); assert.match(seen.at(-1).system, /独立游戏开发者/); assert.doesNotMatch(seen.at(-1).system, /北京朝阳/);
  seen = []; await ask('用户B', '帮我优化一下游戏代码');
  assert.doesNotMatch(seen.at(-1).system, /独立游戏开发者/, '别的会话看不到');

  await ask('用户B', '记住：我的订单号是 A-1024');
  const all = (await call(owner, `/api/bots/${bot.id}/memories`)).data.memories;
  assert.ok(all.some(m => m.session === '用户B' && m.text === '我的订单号是 A-1024' && m.pinned));
  seen = []; await ask('用户A', '订单号是多少呀');
  assert.doesNotMatch(seen.at(-1).system, /A-1024/, '“记住”只进本会话');
  assert.ok((await call(owner, '/api/memories')).data.memories.every(m => !/Lua|A-1024/.test(m.text)), '主人的个人记忆列表不含机器人记忆');
  assert.equal((await call(owner, '/api/bots')).data.bots[0].memoryCount >= 2, true);

  // 开关
  assert.equal((await call(owner, `/api/bots/${bot.id}`, 'PATCH', { memory: false })).data.bot.memory, false);
  seen = []; await ask('用户A', '再帮我看看代码问题');
  assert.doesNotMatch(seen.at(-1).system, /独立游戏开发者/, '关闭后不注入');
  await call(owner, `/api/bots/${bot.id}`, 'PATCH', { memory: true });

  // 别人不能看；删除单条 / 按会话清空 / 删机器人
  await call(owner, '/api/admin/members', 'POST', { email: 'bm@example.com', password: 'member-password-12345' });
  const other = await login({ email: 'bm@example.com', password: 'member-password-12345' });
  assert.equal((await call(other, `/api/bots/${bot.id}/memories`)).status, 404);
  const one = all.find(m => m.session === '用户B');
  assert.equal((await call(owner, `/api/bots/${bot.id}/memories/${one.id}`, 'DELETE')).data.removed, 1);
  const cleared = await call(owner, `/api/bots/${bot.id}/memories?session=${encodeURIComponent('用户A')}`, 'DELETE');
  assert.ok(cleared.data.removed >= 1);
  assert.equal((await call(owner, `/api/bots/${bot.id}/memories`)).data.memories.filter(m => m.session === '用户A').length, 0);
  assert.equal((await call(owner, `/api/bots/${bot.id}`, 'DELETE')).status, 200);
  assert.equal((await call(owner, `/api/bots/${bot.id}/memories`)).status, 404);
});

async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
}

test('接口记忆：/v1 与 /v1/messages 传会话标识才启用，按会话隔离，不带个人记忆', async () => {
  await call(owner, '/api/memories', 'DELETE');
  await call(owner, '/api/api-memory', 'DELETE');
  await call(owner, '/api/memories', 'POST', { text: '主人的私人信息：住在北京朝阳区', pinned: true });
  const token = (await call(owner, '/api/tokens', 'POST', { name: 'mem' })).data.token;
  const openai = (session, text, extra = {}) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(session ? { 'X-Session-Id': session } : {}) }, body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: text }], ...extra }) });
  const listed = async () => (await call(owner, '/api/api-memory')).data.memories;

  // 没有会话标识：保持无状态，什么都不记
  let r = await openai(null, '我是独立游戏开发者，主要用 Lua 写游戏');
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-memory-used'), null);
  await new Promise(done => setTimeout(done, 400));
  assert.equal((await listed()).length, 0);

  // 带会话标识：后台提取
  seen = [];
  r = await openai('appA', '我是独立游戏开发者，主要用 Lua 写游戏');
  assert.equal(r.headers.get('x-memory-used'), '0'); assert.doesNotMatch(seen.at(-1).system, /北京朝阳/, '不带个人记忆');
  assert.ok(await until(async () => (await listed()).find(m => m.session === 'appA' && /Lua/.test(m.text))));

  // 同一会话（这次用 OpenAI 的 user 字段）再次调用会带上；别的会话不带
  seen = []; r = await openai(null, '帮我优化游戏代码', { user: 'appA' });
  assert.ok(Number(r.headers.get('x-memory-used')) >= 1); assert.match(seen.at(-1).system, /独立游戏开发者/);
  seen = []; await openai('appB', '帮我优化游戏代码');
  assert.doesNotMatch(seen.at(-1).system, /独立游戏开发者/);

  // Anthropic 兼容接口：metadata.user_id
  seen = [];
  const claude = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'x-api-key': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-x', max_tokens: 50, metadata: { user_id: 'appA' }, messages: [{ role: 'user', content: '再帮我看看游戏代码' }] }) });
  assert.equal(claude.status, 200); assert.ok(Number(claude.headers.get('x-memory-used')) >= 1); assert.match(seen.at(-1).system, /独立游戏开发者/);

  // 流式 + 显式“记住”只进本会话
  const stream = await openai('appC', '记住：我的偏好是深色模式', { stream: true });
  assert.equal(stream.status, 200); await stream.text();
  assert.ok((await listed()).some(m => m.session === 'appC' && m.text === '我的偏好是深色模式' && m.pinned));
  seen = []; await openai('appA', '我的偏好是什么');
  assert.doesNotMatch(seen.at(-1).system, /深色模式/);
  assert.ok((await call(owner, '/api/memories')).data.memories.every(m => !/Lua|深色模式/.test(m.text)), '个人记忆列表不含接口记忆');

  // 别人看不到；单条删除、按会话清空
  await call(owner, '/api/admin/members', 'POST', { email: 'am@example.com', password: 'member-password-12345' });
  const other = await login({ email: 'am@example.com', password: 'member-password-12345' });
  assert.equal((await call(other, '/api/api-memory')).data.memories.length, 0);
  const one = (await listed()).find(m => m.session === 'appC');
  assert.equal((await call(owner, '/api/api-memory/' + one.id, 'DELETE')).data.removed, 1);
  assert.ok((await call(owner, '/api/api-memory?session=appA', 'DELETE')).data.removed >= 1);
  assert.equal((await listed()).filter(m => m.session === 'appA').length, 0);

  // 总开关关闭：不记也不带
  await call(owner, '/api/memory/prefs', 'PUT', { enabled: false });
  r = await openai('appA', '我是独立游戏开发者，主要用 Lua 写游戏');
  assert.equal(r.headers.get('x-memory-used'), null);
  await call(owner, '/api/memory/prefs', 'PUT', { enabled: true });
});
