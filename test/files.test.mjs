import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../runner/runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
const RUNNER_TOKEN = 'runner-token-abcdefghij';
let dir, runnerServer, app, base, owner, wsDir, ws;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const exists = file => access(file).then(() => true, () => false);
const DAY = 86400000;
const age = async (file, days) => { const t = new Date(Date.now() - days * DAY); await utimes(file, t, t); };

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-files-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin'), tokenFile = path.join(dir, 'rt');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password); await writeFile(tokenFile, RUNNER_TOKEN);
  runnerServer = createRunner({ token: RUNNER_TOKEN, root: path.join(dir, 'ws'), env: { ...process.env } });
  const runnerPort = await listen(runnerServer);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'm', MODEL_API_KEY: 'k', RUNNER_URL: `http://127.0.0.1:${runnerPort}`, RUNNER_TOKEN_FILE: tokenFile, WORKSPACE_CLEANUP_INTERVAL_MS: '700', WORKSPACE_UPLOAD_MAX_MB: '1' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
  ws = (await call(owner, '/api/workspaces', 'POST', { name: '文件测试' })).data.workspace.id;
  wsDir = path.join(dir, 'ws', ws);
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); runnerServer?.close(); runnerServer?.closeAllConnections?.(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
}
const call = async (auth, p, method = 'GET', body) => {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
const put = (rel, content) => call(owner, `/api/workspaces/${ws}/files?path=${encodeURIComponent(rel)}`, 'PUT', { content });
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };

test('版本备份：覆盖、删除都会先存一版，相同内容不重复，可还原', async () => {
  await put('notes/a.md', 'v1');
  assert.equal((await call(owner, `/api/workspaces/${ws}/versions?path=notes/a.md`)).data.versions.length, 0, '首次创建没有旧版本');
  await put('notes/a.md', 'v2');
  await put('notes/a.md', 'v2'); // 内容相同
  await put('notes/a.md', 'v3');
  const versions = (await call(owner, `/api/workspaces/${ws}/versions?path=notes/a.md`)).data.versions;
  assert.equal(versions.length, 2, 'v1、v2 各一版，没有重复');
  const old = versions.at(-1);
  assert.equal((await call(owner, `/api/workspaces/${ws}/versions?path=notes/a.md&id=${old.id}`)).data.content, 'v1');

  await call(owner, `/api/workspaces/${ws}/files?path=notes/a.md`, 'DELETE');
  assert.equal(await exists(path.join(wsDir, 'notes/a.md')), false);
  const hist = (await call(owner, `/api/workspaces/${ws}/history`)).data.files.find(f => f.path === 'notes/a.md');
  assert.equal(hist.exists, false); assert.equal(hist.versions, 3);
  const latest = (await call(owner, `/api/workspaces/${ws}/versions?path=notes/a.md`)).data.versions[0];
  assert.equal((await call(owner, `/api/workspaces/${ws}/restore`, 'POST', { path: 'notes/a.md', id: latest.id })).status, 200);
  assert.equal(await readFile(path.join(wsDir, 'notes/a.md'), 'utf8'), 'v3');
  assert.equal((await call(owner, `/api/workspaces/${ws}/restore`, 'POST', { path: '../x', id: latest.id })).status, 400);
});

test('过期清理：候选清单 → 人工确认才删 → 先备份 → 保护路径 → 可还原', async () => {
  await put('old/report.txt', '旧报告'); await put('old/keep/important.txt', '重要'); await put('fresh.txt', '新文件'); await put('stale.txt', '陈旧');
  await age(path.join(wsDir, 'old/report.txt'), 40); await age(path.join(wsDir, 'old/keep/important.txt'), 40); await age(path.join(wsDir, 'stale.txt'), 40);
  assert.equal((await call(owner, `/api/workspaces/${ws}/expiry`)).data.candidates.length, 0, '未设置规则时没有候选');
  assert.equal((await call(owner, `/api/workspaces/${ws}/expiry`, 'PUT', { days: 3 })).status, 400, '天数太小被拒绝');
  assert.equal((await call(owner, `/api/workspaces/${ws}/expiry`, 'PUT', { days: 30, protect: ['old/keep'] })).status, 200);
  const info = (await call(owner, `/api/workspaces/${ws}/expiry`)).data;
  assert.deepEqual(info.candidates.map(c => c.path).sort(), ['old/report.txt', 'stale.txt'], '保护路径和新文件不在清单里');
  assert.equal(info.policy.autoDelete, false);

  const items = info.candidates.map(c => ({ path: c.path, mtime: c.mtime }));
  assert.equal((await call(owner, `/api/workspaces/${ws}/expiry/approve`, 'POST', { items })).status, 400);
  const sneaky = (await call(owner, `/api/workspaces/${ws}/expiry/approve`, 'POST', { confirm: true, items: [{ path: 'fresh.txt', mtime: 1 }] })).data;
  assert.equal(sneaky.deleted.length, 0); assert.equal(await exists(path.join(wsDir, 'fresh.txt')), true);

  await put('stale.txt', '又改了'); await age(path.join(wsDir, 'stale.txt'), 40);
  const approved = (await call(owner, `/api/workspaces/${ws}/expiry/approve`, 'POST', { confirm: true, items })).data;
  assert.deepEqual(approved.deleted, ['old/report.txt']);
  assert.equal(approved.skipped.length, 1);
  assert.equal(await exists(path.join(wsDir, 'old/report.txt')), false);
  assert.equal(await exists(path.join(wsDir, 'old/keep/important.txt')), true);

  const versions = (await call(owner, `/api/workspaces/${ws}/versions?path=old/report.txt`)).data.versions;
  assert.equal(versions.length, 1);
  assert.equal((await call(owner, `/api/workspaces/${ws}/versions?path=old/report.txt&id=${versions[0].id}`)).data.content, '旧报告');
  assert.ok((await call(owner, `/api/workspaces/${ws}/expiry`)).data.log.some(l => l.by === ADMIN.email && l.deleted === 1));
});

test('过期清理：普通成员不能确认删除；自动删除需确认才能开启并按规则执行', async () => {
  await call(owner, '/api/admin/members', 'POST', { email: 'm@example.com', password: 'member-password-12345' });
  await call(owner, `/api/workspaces/${ws}`, 'PATCH', { members: ['m@example.com'] });
  const mine = await login({ email: 'm@example.com', password: 'member-password-12345' });
  assert.equal((await call(mine, `/api/workspaces/${ws}/expiry`)).data.canManage, false);
  assert.equal((await call(mine, `/api/workspaces/${ws}/expiry/approve`, 'POST', { confirm: true, items: [{ path: 'stale.txt', mtime: 1 }] })).status, 403);
  assert.equal((await call(mine, `/api/workspaces/${ws}/expiry`, 'PUT', { days: 30 })).status, 403);
  assert.equal((await call(mine, `/api/workspaces/${ws}/history`)).status, 200, '成员可以看历史');

  assert.equal((await call(owner, `/api/workspaces/${ws}/expiry`, 'PUT', { days: 30, protect: ['old/keep'], autoDelete: true })).status, 400, '未确认不能开自动删除');
  const on = await call(owner, `/api/workspaces/${ws}/expiry`, 'PUT', { days: 30, protect: ['old/keep'], autoDelete: true, confirm: true });
  assert.equal(on.data.policy.autoEnabledBy, ADMIN.email);
  assert.ok(await until(async () => !(await exists(path.join(wsDir, 'stale.txt')))), '自动清理删除了过期文件');
  assert.equal(await exists(path.join(wsDir, 'fresh.txt')), true);
  assert.equal(await exists(path.join(wsDir, 'old/keep/important.txt')), true, '保护路径不动');
  assert.ok((await call(owner, `/api/workspaces/${ws}/versions?path=stale.txt`)).data.versions.length >= 1, '自动删除前也有备份');
});

test('上传下载：二进制往返一致、覆盖前备份、超限/越界被拒、成员可用、非成员不可见', async () => {
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 128, 200]);
  const raw = (auth, p, method, data) => fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(data ? { 'Content-Type': 'application/octet-stream' } : {}) }, body: data });
  const up = (auth, rel, data) => raw(auth, `/api/workspaces/${ws}/upload?path=${encodeURIComponent(rel)}`, 'PUT', data);
  const down = (auth, rel) => raw(auth, `/api/workspaces/${ws}/download?path=${encodeURIComponent(rel)}`, 'GET');

  let r = await up(owner, 'assets/logo.bin', bin);
  assert.equal(r.status, 200); assert.equal((await r.json()).size, bin.length);
  assert.deepEqual(await readFile(path.join(wsDir, 'assets/logo.bin')), bin, '落盘内容和上传的一致');
  r = await down(owner, 'assets/logo.bin');
  assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), bin, '下载内容一致（含 0 字节）');
  assert.match(r.headers.get('content-disposition'), /^attachment;/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.match(r.headers.get('content-security-policy'), /sandbox/);

  // 覆盖：旧内容先备份
  const bin2 = Buffer.from([9, 9, 0, 9]);
  assert.equal((await up(owner, 'assets/logo.bin', bin2)).status, 200);
  const versions = (await call(owner, `/api/workspaces/${ws}/versions?path=assets/logo.bin`)).data.versions;
  assert.equal(versions.length, 1); assert.equal(versions[0].size, bin.length);
  assert.equal((await call(owner, `/api/workspaces/${ws}/versions?path=assets/logo.bin&id=${versions[0].id}`)).data.type, 'binary');

  // 限额（测试里设为 1 MB）、越界路径、不存在/目录
  assert.equal((await up(owner, 'big.bin', Buffer.alloc(1.5 * 1048576, 1))).status, 413, '超过上限被拒');
  assert.equal(await exists(path.join(wsDir, 'big.bin')), false);
  assert.equal((await up(owner, '../evil.bin', bin)).status, 400);
  assert.equal((await up(owner, '/etc/evil.bin', bin)).status, 400);
  assert.equal((await down(owner, 'nope.bin')).status, 404);
  assert.equal((await down(owner, 'assets')).status, 400, '目录不能下载');

  // 工作区成员可以上传下载，非成员看不到这个工作区
  await call(owner, '/api/admin/members', 'POST', { email: 'x@example.com', password: 'member-password-12345' });
  const member = await login({ email: 'm@example.com', password: 'member-password-12345' }), stranger = await login({ email: 'x@example.com', password: 'member-password-12345' });
  assert.equal((await up(member, 'from-member.bin', bin)).status, 200);
  assert.deepEqual(Buffer.from(await (await down(owner, 'from-member.bin')).arrayBuffer()), bin);
  assert.equal((await up(stranger, 'x.bin', bin)).status, 404); assert.equal((await down(stranger, 'assets/logo.bin')).status, 404);

  const audit = (await call(owner, '/api/audit?action=file.upload&limit=50')).data.entries;
  assert.ok(audit.some(e => e.target === 'assets/logo.bin') && audit.some(e => e.email === 'm@example.com'), '上传被记入审计');
  assert.ok((await call(owner, '/api/audit?action=file.download')).data.entries.length >= 1);
});

test('工作区文件搜索：文件名 + 内容（忽略大小写），返回命中行；跳过二进制、node_modules、.versions；参数校验；非成员 404', async () => {
  await put('docs/Readme.md', '# 项目说明\nHello World\n第二行没有\nhello again');
  await put('src/app.js', "console.log('Hello');\nconst helloWorld = 1;\n");
  await put('notes/hello-notes.txt', '没有关键词的内容');
  await put('node_modules/pkg/index.js', 'hello from deps');
  await put('docs/data.txt', 'x'.repeat(10));
  const bin = Buffer.concat([Buffer.from('hello'), Buffer.from([0, 1, 2, 3])]);
  const upload = await fetch(base + `/api/workspaces/${ws}/upload?path=${encodeURIComponent('assets/hello.bin')}`, { method: 'PUT', headers: { Origin: base, Cookie: owner.cookie, 'X-CSRF-Token': owner.csrf, 'Content-Type': 'application/octet-stream' }, body: bin });
  assert.equal(upload.status, 200);

  const both = (await call(owner, `/api/workspaces/${ws}/search?q=HELLO&content=1`)).data;
  const byPath = Object.fromEntries(both.results.map(r => [r.path, r]));
  assert.deepEqual(Object.keys(byPath).sort(), ['assets/hello.bin', 'docs/Readme.md', 'notes/hello-notes.txt', 'src/app.js'], 'node_modules 里的文件被跳过，大小写不敏感');
  assert.equal(byPath['notes/hello-notes.txt'].nameHit, true); assert.deepEqual(byPath['notes/hello-notes.txt'].lines, [], '只有文件名命中');
  assert.deepEqual(byPath['docs/Readme.md'].lines.map(l => l.n), [2, 4], '内容命中给出行号'); assert.equal(byPath['docs/Readme.md'].lines[0].text, 'Hello World');
  assert.equal(byPath['docs/Readme.md'].nameHit, false);
  assert.equal(byPath['assets/hello.bin'].nameHit, true); assert.deepEqual(byPath['assets/hello.bin'].lines, [], '二进制文件不搜内容');
  assert.deepEqual(byPath['src/app.js'].lines.map(l => l.n), [1, 2]);

  const namesOnly = (await call(owner, `/api/workspaces/${ws}/search?q=hello&content=0`)).data.results.map(r => r.path).sort();
  assert.deepEqual(namesOnly, ['assets/hello.bin', 'notes/hello-notes.txt'], '不搜内容时只看文件名');
  assert.equal((await call(owner, `/api/workspaces/${ws}/search?q=${encodeURIComponent('项目说明')}&content=1`)).data.results[0].path, 'docs/Readme.md', '中文内容也能搜到');
  assert.deepEqual((await call(owner, `/api/workspaces/${ws}/search?q=zzzz-not-found&content=1`)).data.results, []);
  assert.equal((await call(owner, `/api/workspaces/${ws}/search?q=`)).status, 400);
  assert.equal((await call(owner, `/api/workspaces/${ws}/search?q=${'a'.repeat(101)}`)).status, 400);
  await call(owner, '/api/admin/members', 'POST', { email: 'search-x@example.com', password: 'member-password-12345' });
  const stranger = await login({ email: 'search-x@example.com', password: 'member-password-12345' });
  assert.equal((await call(stranger, `/api/workspaces/${ws}/search?q=hello`)).status, 404, '非成员看不到这个工作区');
});
