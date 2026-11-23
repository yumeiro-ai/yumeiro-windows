import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, model, app, base, owner;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-extras-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  // 模型回显：有没有系统提示词、系统提示词内容、消息条数、最后一条
  model = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw), system = body.messages.find(m => m.role === 'system')?.content || '', last = body.messages.at(-1).content;
      const reply = `sys=[${system}];n=${body.messages.filter(m => m.role !== 'system').length};last=${last}`;
      if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n'); return res.end('data: [DONE]\n\n'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { total_tokens: 2 } }));
    });
  });
  const modelPort = await listen(model);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'test-model', MODEL_API_KEY: 'k' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('exit ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); model?.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  const data = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
}
async function call(auth, p, method = 'GET', body, raw) {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, headers: response.headers, data: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
const member = async (email) => { const account = { email, password: 'member-password-12345' }; await call(owner, '/api/admin/members', 'POST', account); return login(account); };

test('技能工坊：创建/导入/导出、共享可见性、权限，绑定到智能体后进入系统提示词', async () => {
  const mine = await member('skill-user@example.com');
  const skill = (await call(owner, '/api/skills', 'POST', { title: '代码审查', description: '审查代码时用', content: '先看安全问题，再看可读性。', shared: true })).data.skill;
  assert.equal((await call(mine, '/api/skills')).data.skills.length, 1, '共享技能所有人可见');
  assert.equal((await call(mine, '/api/skills/' + skill.id, 'PATCH', { title: 'x', content: 'y' })).status, 403);
  assert.equal((await call(mine, '/api/skills', 'POST', { title: '', content: 'x' })).status, 400);
  assert.equal((await call(mine, '/api/skills', 'POST', { title: '私人', content: '只给我', shared: true })).data.skill.shared, false, '成员不能共享');

  const imported = await call(mine, '/api/skills/import', 'POST', { markdown: '---\nname: 翻译助手\ndescription: 中英互译\n---\n\n保持原意，不要加评论。' });
  assert.equal(imported.status, 201);
  assert.equal(imported.data.skill.title, '翻译助手');
  assert.equal(imported.data.skill.content, '保持原意，不要加评论。');
  assert.equal((await call(mine, '/api/skills/import', 'POST', { markdown: '没有标题也没有前言' })).status, 400);
  const exported = await call(mine, `/api/skills/${imported.data.skill.id}/export`);
  assert.match(exported.type, /markdown/);
  assert.match(exported.data.toString(), /^---\nname: 翻译助手\ndescription: 中英互译\n---/);

  // 绑定到智能体 → v1 调用时系统提示词里带上技能
  const agent = (await call(mine, '/api/agents', 'POST', { name: '审稿员', systemPrompt: '你是审稿员', skillIds: [skill.id, imported.data.skill.id] })).data.agent;
  assert.equal(agent.skillIds.length, 2);
  assert.equal((await call(mine, '/api/agents', 'POST', { name: 'bad', skillIds: ['00000000-0000-4000-8000-000000000000'] })).status, 400);
  const token = (await call(mine, '/api/tokens', 'POST', { name: 't' })).data.token;
  const reply = await (await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'agent:' + agent.id, messages: [{ role: 'user', content: '审一下' }] }) })).json();
  const text = reply.choices[0].message.content;
  assert.match(text, /你是审稿员/);
  assert.match(text, /## 代码审查/);
  assert.match(text, /先看安全问题/);
  assert.match(text, /## 翻译助手/);

  // 删除技能会从智能体上解除
  assert.equal((await call(mine, '/api/skills/' + imported.data.skill.id, 'DELETE')).status, 200);
  assert.equal((await call(mine, '/api/agents')).data.agents.find(a => a.id === agent.id).skillIds.length, 1);
});

test('机器人：Webhook 令牌校验、绑定智能体、同一 session 保留上下文、不同 session 隔离、换令牌/删除', async () => {
  const agent = (await call(owner, '/api/agents', 'POST', { name: '客服', systemPrompt: '你是客服' })).data.agent;
  const created = await call(owner, '/api/bots', 'POST', { name: '客服机器人', agentId: agent.id });
  assert.equal(created.status, 201);
  const { bot, token } = created.data;
  assert.match(token, /^bot_/);
  assert.equal(JSON.stringify((await call(owner, '/api/bots')).data).includes(token), false, '令牌只显示一次');
  assert.equal((await call(owner, '/api/bots', 'POST', { name: 'x', agentId: 'nope' })).status, 400);

  const hook = (text, session, auth = token) => fetch(`${base}/bot/${bot.id}`, { method: 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, session }) }).then(async r => ({ status: r.status, data: await r.json() }));
  assert.equal((await hook('你好', 'a', 'bot_wrong')).status, 401);
  assert.equal((await fetch(`${base}/bot/${bot.id}`, { method: 'GET' })).status, 405);
  assert.equal((await hook('', 'a')).status, 400);

  const first = await hook('你好', 'user-a');
  assert.equal(first.status, 200);
  assert.match(first.data.reply, /sys=\[你是客服\];n=1;last=你好/);
  const second = await hook('再问一句', 'user-a');
  assert.match(second.data.reply, /n=3;last=再问一句/, '同一个 session 要带上之前的对话');
  assert.match((await hook('新用户', 'user-b')).data.reply, /n=1;last=新用户/, '不同 session 互相隔离');

  // 机器人的会话不出现在主人的对话列表里；用量计入主人
  assert.equal((await call(owner, '/api/conversations')).data.conversations.some(c => c.title.startsWith('机器人')), false);
  assert.ok((await call(owner, '/api/usage/me')).data.usage.sources.bot >= 3);

  const rotated = (await call(owner, `/api/bots/${bot.id}/rotate`, 'POST', {})).data.token;
  assert.equal((await hook('旧令牌', 'user-a')).status, 401);
  assert.equal((await hook('新令牌', 'user-a', rotated)).status, 200);
  assert.equal((await call(owner, '/api/bots/' + bot.id, 'DELETE')).status, 200);
  assert.equal((await hook('已删除', 'user-a', rotated)).status, 401);
});

test('壁纸：上传校验（内容与扩展名必须匹配）、权限、个人选择与暗度、全员默认、读取、删除', async () => {
  const mine = await member('wall-user@example.com');
  assert.equal((await call(mine, '/api/admin/wallpapers/a.webp', 'PUT', WEBP, true)).status, 403);
  assert.equal((await call(owner, '/api/admin/wallpapers/evil.exe', 'PUT', WEBP, true)).status, 400);
  assert.equal((await call(owner, '/api/admin/wallpapers/fake.webp', 'PUT', Buffer.from('not an image at all'), true)).status, 400);
  assert.equal((await call(owner, '/api/admin/wallpapers/..%2Fx.webp', 'PUT', WEBP, true)).status, 404);
  assert.equal((await call(owner, '/api/admin/wallpapers/sky.webp', 'PUT', WEBP, true)).status, 200);
  assert.equal((await call(owner, '/api/admin/wallpapers/pic.png', 'PUT', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), true)).status, 200);

  const list = (await call(mine, '/api/wallpapers')).data;
  assert.deepEqual(list.items.map(i => i.name), ['pic.png', 'sky.webp']);
  assert.equal(list.pref.wallpaper, null);
  const file = await call(mine, '/api/wallpapers/file/sky.webp');
  assert.equal(file.status, 200);
  assert.equal(file.type, 'image/webp');
  assert.equal((await call(mine, '/api/wallpapers/file/nope.webp')).status, 404);
  assert.equal((await fetch(base + '/api/wallpapers/file/sky.webp')).status, 401, '没登录不能读取');

  assert.equal((await call(mine, '/api/wallpapers/pref', 'PUT', { wallpaper: 'missing.webp', dim: 30 })).status, 400);
  assert.equal((await call(mine, '/api/wallpapers/pref', 'PUT', { wallpaper: 'sky.webp', dim: 99 })).status, 400);
  assert.equal((await call(mine, '/api/wallpapers/pref', 'PUT', { wallpaper: 'sky.webp', dim: 50 })).status, 200);
  assert.deepEqual((await call(mine, '/api/wallpapers')).data.pref, { wallpaper: 'sky.webp', dim: 50 });
  assert.equal((await call(mine, '/api/wallpapers/pref', 'PUT', { wallpaper: 'preset:aurora', dim: 20 })).status, 200);

  assert.equal((await call(owner, '/api/admin/wallpapers-default', 'PUT', { name: 'pic.png' })).status, 200);
  assert.equal((await call(owner, '/api/wallpapers')).data.defaultWallpaper, 'pic.png');
  assert.equal((await call(owner, '/api/admin/wallpapers/pic.png', 'DELETE')).status, 200);
  assert.equal((await call(owner, '/api/wallpapers')).data.defaultWallpaper, '', '删除默认壁纸会清掉默认值');
});

test('scripts/fetch-wallpapers.mjs：下载到 DATA_DIR/wallpapers，已存在则跳过，失败如实报告', async () => {
  const files = { 'cindy-neon.webp': WEBP, 'dune-dawn.webp': WEBP };
  const raw = http.createServer((req, res) => {
    const name = req.url.split('/').pop();
    if (files[name]) { res.writeHead(200); return res.end(files[name]); }
    res.writeHead(404); res.end();
  });
  const rawPort = await listen(raw);
  const out = await mkdtemp(path.join(tmpdir(), 'wall-fetch-'));
  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/fetch-wallpapers.mjs', '--accept-terms'], { cwd: root, env: { ...process.env, DATA_DIR: out, GITHUB_RAW_BASE: `http://127.0.0.1:${rawPort}/makecindy/cindy/main` } });
    let text = ''; child.stdout.on('data', c => { text += c; }); child.stderr.on('data', c => { text += c; });
    child.on('exit', code => resolve({ code, text }));
  });
  try {
    const refused = await new Promise(resolve => { const c = spawn(process.execPath, ['scripts/fetch-wallpapers.mjs'], { cwd: root, env: { ...process.env, DATA_DIR: out, FETCH_WALLPAPERS_ACCEPT: '' } }); c.on('exit', code => resolve(code)); });
    assert.equal(refused, 2, '没有 --accept-terms 时不应下载');
    const first = await run();
    assert.equal(first.code, 0, first.text);
    assert.deepEqual((await readdir(path.join(out, 'wallpapers'))).sort(), ['cindy-neon.webp', 'dune-dawn.webp']);
    assert.match(first.text, /2 个成功，14 个失败/);
    assert.match(first.text, /授权/);
    assert.match((await run()).text, /已存在，跳过 cindy-neon\.webp/);
    assert.equal((await readFile(path.join(out, 'wallpapers', 'cindy-neon.webp'))).length, WEBP.length);
  } finally { raw.close(); await rm(out, { recursive: true, force: true }); }
});

function makeZip(files) {
  const zlib = globalThis.__zlib; const locals = [], centrals = []; let offset = 0;
  for (const [name, content, stored] of files) {
    const nameBuf = Buffer.from(name), data = Buffer.from(content), packed = stored ? data : zlib.deflateRawSync(data), crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed); centrals.push(central, nameBuf); offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('技能上传：zip 内多个 SKILL.md、忽略脚本、限制大小、坏包报错；引擎可选模型的配置', async () => {
  globalThis.__zlib = (await import('node:zlib')).default;
  const mine = await member('uploader@example.com');
  const zip = makeZip([
    ['pack/review/SKILL.md', '---\nname: 评审技能\ndescription: 评审用\n---\n\n先看风险。'],
    ['pack/notes/SKILL.md', '没有前言，目录名做标题', true],
    ['pack/review/run.sh', 'rm -rf /'],
    ['__MACOSX/pack/SKILL.md', '垃圾文件'],
  ]);
  const ok = await call(mine, '/api/skills/import-zip', 'POST', { data: zip.toString('base64') });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.created.map(s => s.title).sort(), ['notes', '评审技能']);
  assert.equal(ok.data.ignoredFiles, 2, '脚本和 __MACOSX 里的文件被忽略');
  assert.equal(ok.data.created.every(s => s.shared === false), true, '上传的技能默认不共享');
  const listed = (await call(mine, '/api/skills')).data.skills.map(s => s.title);
  assert.ok(listed.includes('评审技能') && !listed.some(t => /rm -rf/.test(t)));
  // 没有 SKILL.md / 不是 zip / 空内容
  assert.equal((await call(mine, '/api/skills/import-zip', 'POST', { data: makeZip([['a.txt', 'hi']]).toString('base64') })).status, 400);
  assert.equal((await call(mine, '/api/skills/import-zip', 'POST', { data: Buffer.from('not a zip').toString('base64') })).status, 400);
  assert.equal((await call(mine, '/api/skills/import-zip', 'POST', { data: '' })).status, 400);
  // 单个文件超过 256KB 被拒绝
  const big = makeZip([['x/SKILL.md', '---\nname: big\n---\n' + 'a'.repeat(300 * 1024)]]);
  assert.equal((await call(mine, '/api/skills/import-zip', 'POST', { data: big.toString('base64') })).status, 400);
  // 内容超过 20000 字符：该技能被跳过并给出原因
  const long = await call(mine, '/api/skills/import-zip', 'POST', { data: makeZip([['x/SKILL.md', '---\nname: long\n---\n' + 'a'.repeat(21000)], ['y/SKILL.md', '---\nname: fine\n---\nok']]).toString('base64') });
  assert.equal(long.status, 201);
  assert.equal(long.data.created.length, 1);
  assert.match(long.data.skipped[0].reason, /20000/);

  // 引擎可选模型：管理员配置，非法名称被过滤
  const put = await call(owner, '/api/admin/engines/claude', 'PUT', { enabled: true, membersAllowed: true, models: 'sonnet\nopus\nbad name!\n$(rm)' });
  assert.equal(put.status, 200);
  const engines = (await call(owner, '/api/admin/engines')).data.engines;
  assert.deepEqual(engines.find(e => e.engine === 'claude').models, ['sonnet', 'opus']);
});

test('壁纸大文件：超过上限在读取正文前就按 Content-Length 拒绝；生成的带时间戳文件名可上传', async () => {
  const big = Buffer.concat([WEBP, Buffer.alloc(9 * 1024 * 1024)]);
  const started = Date.now();
  const rejected = await call(owner, '/api/admin/wallpapers/huge.webp', 'PUT', big, true);
  assert.equal(rejected.status, 413);
  assert.match(rejected.data.error, /上限 8 MB/);
  assert.ok(Date.now() - started < 5000);
  // 前端上传使用的命名：stem-时间戳.ext（中文原名会退化为 wallpaper-xxxx.webp）
  assert.equal((await call(owner, '/api/admin/wallpapers/wallpaper-mh3k2x9.webp', 'PUT', WEBP, true)).status, 200);
  assert.equal((await call(owner, '/api/admin/wallpapers/----.webp', 'PUT', WEBP, true)).status, 400, '以连字符开头的名字被拒绝，所以前端必须生成合规文件名');
});

test('市场：内置技能/机器人模板安装；投稿审核上架；权限与去重', async () => {
  const alice = await member('market-alice@example.com'), bob = await member('market-bob@example.com');
  const m0 = (await call(alice, '/api/market')).data;
  assert.ok(m0.skills.length >= 8 && m0.bots.length >= 6);
  assert.ok(m0.skills.every(s => s.installed === false && s.source === 'builtin'));

  // 安装内置技能：复制成自己的技能，不能重复安装
  const inst = await call(alice, '/api/market/install', 'POST', { type: 'skill', key: 'builtin:translate' });
  assert.equal(inst.status, 201);
  assert.equal(inst.data.skill.title, '中英互译');
  assert.equal(inst.data.skill.shared, false);
  assert.equal((await call(alice, '/api/market/install', 'POST', { type: 'skill', key: 'builtin:translate' })).status, 409);
  assert.equal((await call(alice, '/api/market')).data.skills.find(s => s.key === 'builtin:translate').installed, true);
  assert.equal((await call(bob, '/api/market')).data.skills.find(s => s.key === 'builtin:translate').installed, false, '别人的安装状态互不影响');
  assert.equal((await call(alice, '/api/market/install', 'POST', { type: 'skill', key: 'builtin:nope' })).status, 404);

  // 安装机器人模板：生成智能体 + 绑定技能（复用已安装的）+ 机器人和令牌
  const bot = await call(alice, '/api/market/install', 'POST', { type: 'bot', key: 'builtin:translator' });
  assert.equal(bot.status, 201);
  assert.match(bot.data.token, /^bot_/);
  assert.equal(bot.data.agent.skillIds.length, 1);
  assert.equal((await call(alice, '/api/skills')).data.skills.filter(s => s.title === '中英互译').length, 1, '已安装的技能被复用，不重复创建');
  assert.equal((await call(alice, '/api/market/install', 'POST', { type: 'bot', key: 'builtin:translator' })).status, 409);
  assert.equal((await call(alice, '/api/bots')).data.bots.length, 1);

  // 投稿：成员 → 待审核（别人看不到）→ 管理员通过后上架
  const mine = (await call(alice, '/api/skills', 'POST', { title: '我的写作规范', description: '写文章用', content: '先列提纲，再写正文。' })).data.skill;
  const sub = await call(alice, '/api/market/publish', 'POST', { type: 'skill', id: mine.id, tags: '写作,办公' });
  assert.equal(sub.status, 201); assert.equal(sub.data.published, false);
  assert.equal((await call(alice, '/api/market/publish', 'POST', { type: 'skill', id: mine.id })).status, 409, '审核中不能重复投稿');
  assert.equal((await call(bob, '/api/market')).data.skills.some(s => s.title === '我的写作规范'), false);
  assert.equal((await call(bob, '/api/admin/market')).status, 403);
  assert.equal((await call(bob, `/api/admin/market/${sub.data.item.id}`, 'PATCH', { action: 'approve' })).status, 403);
  const pending = (await call(owner, '/api/admin/market')).data;
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].author.includes('market-alice') || pending.pending[0].author.length > 0, true);
  assert.equal((await call(owner, `/api/admin/market/${sub.data.item.id}`, 'PATCH', { action: 'bogus' })).status, 400);
  assert.equal((await call(owner, `/api/admin/market/${sub.data.item.id}`, 'PATCH', { action: 'approve' })).status, 200);
  const seen = (await call(bob, '/api/market')).data.skills.find(s => s.title === '我的写作规范');
  assert.ok(seen && seen.source === 'community' && seen.tags.includes('写作'));
  const got = await call(bob, '/api/market/install', 'POST', { type: 'skill', key: seen.key });
  assert.equal(got.status, 201); assert.equal(got.data.skill.content, '先列提纲，再写正文。');
  // 上架后作者再改原技能，不影响已上架的快照
  await call(alice, '/api/skills/' + mine.id, 'PATCH', { content: '改过的内容' });
  assert.equal((await call(bob, '/api/skills')).data.skills.find(s => s.title === '我的写作规范').content, '先列提纲，再写正文。');

  // 下架 / 撤回
  assert.equal((await call(owner, `/api/admin/market/${sub.data.item.id}`, 'PATCH', { action: 'unpublish', note: '内容重复' })).status, 200);
  assert.equal((await call(bob, '/api/market')).data.skills.some(s => s.title === '我的写作规范'), false);
  assert.equal((await call(alice, '/api/market')).data.mine[0].status, 'rejected');
  assert.equal((await call(bob, `/api/market/items/${sub.data.item.id}`, 'DELETE')).status, 404, '别人不能删除我的投稿');
  assert.equal((await call(alice, `/api/market/items/${sub.data.item.id}`, 'DELETE')).status, 200);

  // 机器人模板投稿：必须有带提示词的智能体；管理员投稿直接上架；安装时连带复制技能
  const emptyBot = (await call(bob, '/api/bots', 'POST', { name: '空机器人' })).data.bot;
  assert.equal((await call(bob, '/api/market/publish', 'POST', { type: 'bot', id: emptyBot.id })).status, 400);
  const skill = (await call(owner, '/api/skills', 'POST', { title: '风格指南', content: '用短句。' })).data.skill;
  const agent = (await call(owner, '/api/agents', 'POST', { name: '文案官', description: '写文案', systemPrompt: '你是文案官', skillIds: [skill.id] })).data.agent;
  const ownerBot = (await call(owner, '/api/bots', 'POST', { name: '文案机器人', agentId: agent.id })).data.bot;
  const pub = await call(owner, '/api/market/publish', 'POST', { type: 'bot', id: ownerBot.id, tags: ['文案'] });
  assert.equal(pub.status, 201); assert.equal(pub.data.published, true);
  const tpl = (await call(alice, '/api/market')).data.bots.find(b => b.title === '文案机器人');
  assert.ok(tpl && tpl.skillCount === 1);
  const gotBot = await call(alice, '/api/market/install', 'POST', { type: 'bot', key: tpl.key });
  assert.equal(gotBot.status, 201);
  assert.equal((await call(alice, '/api/skills')).data.skills.some(s => s.title === '风格指南' && s.content === '用短句。' && !s.shared), true);
});

test('技能安装隔离：各装各的、互相看不到；管理员总览能看到每个人装了什么并可移除；推荐来源', async () => {
  const alice = await member('iso-alice@example.com'), bob = await member('iso-bob@example.com');
  const a1 = (await call(alice, '/api/market/install', 'POST', { type: 'skill', key: 'builtin:summarize' })).data.skill;
  await call(alice, '/api/market/install', 'POST', { type: 'bot', key: 'builtin:reporter' });
  const mineBob = (await call(bob, '/api/skills', 'POST', { title: '鲍勃私有', content: '只有我能用' })).data.skill;
  assert.deepEqual(a1.origin, { kind: 'builtin', name: '' });

  // 互相看不到、不能绑定、不能改动
  assert.equal((await call(bob, '/api/skills')).data.skills.some(s => s.id === a1.id), false);
  assert.equal((await call(alice, '/api/skills')).data.skills.some(s => s.id === mineBob.id), false);
  assert.equal((await call(bob, '/api/agents', 'POST', { name: '偷用', skillIds: [a1.id] })).status, 400);
  assert.equal((await call(bob, '/api/skills/' + a1.id, 'PATCH', { title: 'x', content: 'y' })).status, 404);
  assert.equal((await call(bob, '/api/skills/' + a1.id, 'DELETE')).status, 404);
  // 管理员自己的技能列表和可绑定范围同样只含自己的 + 共享的
  assert.equal((await call(owner, '/api/skills')).data.skills.some(s => s.id === a1.id || s.id === mineBob.id), false);
  assert.equal((await call(owner, '/api/agents', 'POST', { name: '管理员偷用', skillIds: [a1.id] })).status, 400);

  // 总览：仅管理员；能看到所有人的技能、来源、内容预览、被几个智能体使用
  assert.equal((await call(alice, '/api/admin/skills')).status, 403);
  assert.equal((await call(alice, '/api/admin/market/suggested')).status, 403);
  const overview = (await call(owner, '/api/admin/skills')).data;
  const rowA = overview.skills.find(s => s.id === a1.id), rowB = overview.skills.find(s => s.id === mineBob.id);
  assert.ok(rowA && rowA.ownerEmail === 'iso-alice@example.com' && rowA.origin.kind === 'builtin' && rowA.marketKey === 'builtin:summarize' && rowA.preview.length > 20);
  assert.ok(rowB && rowB.ownerEmail === 'iso-bob@example.com' && rowB.origin.kind === 'own' && rowB.preview === '只有我能用');
  const userA = overview.users.find(u => u.email === 'iso-alice@example.com');
  assert.ok(userA.skillCount >= 2 && userA.installedCount >= 2, '机器人模板连带安装的技能也计入');
  assert.ok(overview.templates.some(t => t.ownerEmail === 'iso-alice@example.com' && t.marketKey === 'builtin:reporter'), '安装过的机器人模板也能看到');
  // 管理员可以移除某人安装的技能（并解除它在智能体上的绑定）
  assert.equal((await call(owner, '/api/skills/' + a1.id, 'DELETE')).status, 200);
  assert.equal((await call(alice, '/api/skills')).data.skills.some(s => s.id === a1.id), false);
  assert.equal((await call(owner, '/api/admin/skills')).data.skills.some(s => s.id === a1.id), false);
  // 推荐来源
  const suggested = (await call(owner, '/api/admin/market/suggested')).data.suggested;
  assert.ok(suggested.length >= 8 && suggested.every(s => s.added === false && (s.kind === 'clawhub' || /^[\w.-]+\/[\w.-]+$/.test(s.repo))));
  assert.ok(suggested.some(s => s.kind === 'clawhub') && suggested.some(s => s.repo === 'anthropics/skills'));
});
