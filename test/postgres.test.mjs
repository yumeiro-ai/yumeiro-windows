import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import { PgStorage } from '../storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, server, pgPort, dbSeq = 0, shared = null;
const key = randomBytes(32);

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-pg-'));
  pgPort = 45000 + Math.floor(Math.random() * 5000);
  server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pgdata'), user: 'postgres', password: 'pw', port: pgPort, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
});
test.after(async () => { await server?.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

async function newDatabase() {
  const name = 'cindy_' + (++dbSeq);
  await server.createDatabase(name);
  return { name, url: `postgres://postgres:pw@127.0.0.1:${pgPort}/${name}` };
}

test('PgStorage：往返、增量写入、删除、加密、密钥校验、单实例锁', async () => {
  const { url } = await newDatabase();
  const pool = new pg.Pool({ connectionString: url });
  const store = new PgStorage({ pool, key, log: () => {} });
  await store.init();
  assert.equal(await store.isEmpty(), true);

  const db = {
    users: { u1: { id: 'u1', email: 'secret-person@example.com', role: 'admin', passwordHash: 'h' } },
    sessions: { s1: { userId: 'u1', expiresAt: 1 } }, conversations: { c1: { id: 'c1', userId: 'u1', messages: [{ role: 'user', content: '机密内容' }] } },
    tokens: {}, agents: {}, stats: { u1: { months: { '2026-10': { calls: 1 } }, days: {} } },
    usage: [{ userId: 'u1', at: 2, model: 'm' }, { userId: 'u1', at: 1, model: 'm' }], security: { loginPolicy: { maxSessions: 5 }, events: [] }
  };
  await store.save(db);
  const raw = await pool.query('SELECT kind,id,owner,data FROM cindy_entities');
  assert.ok(raw.rowCount >= 6);
  assert.equal(JSON.stringify(raw.rows).includes('secret-person'), false, '数据必须是密文');
  assert.equal(JSON.stringify(raw.rows).includes('机密内容'), false);
  assert.equal(raw.rows.find(r => r.kind === 'conversation').owner, 'u1');

  // 增量：只改一个对话，只有那一行的 updated_at 变化
  const before = (await pool.query("SELECT id,updated_at FROM cindy_entities WHERE kind='user'")).rows[0].updated_at.toISOString();
  db.conversations.c1.messages.push({ role: 'assistant', content: 'ok' });
  await store.save(db);
  assert.equal((await pool.query("SELECT updated_at FROM cindy_entities WHERE kind='user'")).rows[0].updated_at.toISOString(), before);

  delete db.sessions.s1;
  await store.save(db);
  assert.equal((await pool.query("SELECT 1 FROM cindy_entities WHERE kind='session'")).rowCount, 0);

  // 重新加载得到同样的数据，usage 按时间排序
  const again = new PgStorage({ pool: new pg.Pool({ connectionString: url }), key, log: () => {} });
  await assert.rejects(again.init(), /另一个 Yumeiro实例/);
  await again.pool.end();
  await store.close();

  const reopened = new PgStorage({ pool: new pg.Pool({ connectionString: url }), key, log: () => {} });
  await reopened.init();
  const { db: loaded } = await reopened.load();
  assert.equal(loaded.users.u1.email, 'secret-person@example.com');
  assert.equal(loaded.conversations.c1.messages.length, 2);
  assert.deepEqual(loaded.usage.map(u => u.at), [1, 2]);
  assert.equal(loaded.stats.u1.months['2026-10'].calls, 1);
  assert.equal(loaded.sessions.s1, undefined);
  await reopened.close();

  const wrong = new PgStorage({ pool: new pg.Pool({ connectionString: url }), key: randomBytes(32), log: () => {} });
  await assert.rejects(wrong.init(), /密钥/);
  await wrong.pool.end();
});

function startApp(env) {
  const port = 30000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', COOKIE_SECURE: 'false', ...env } });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const ready = new Promise((resolve, reject) => {
    child.on('exit', code => reject(new Error('server exited ' + code + '\n' + output)));
    child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); });
  });
  return { child, ready, base: 'http://127.0.0.1:' + port, output: () => output };
}
async function stop(app) { app.child.removeAllListeners('exit'); app.child.kill(); await new Promise(r => setTimeout(r, 400)); }
async function session(base) {
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(ADMIN) });
  const data = await login.json();
  return { cookie: login.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken, base, status: login.status };
}
const authed = (s, p, method = 'GET', body) => fetch(s.base + p, { method, headers: { Origin: s.base, Cookie: s.cookie, 'X-CSRF-Token': s.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, data: await r.json() }));

test('服务端：JSON → PostgreSQL 自动迁移、重启保留、可切回 JSON', async () => {
  const data = path.join(dir, 'app-data'), keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin-pw');
  await writeFile(keyFile, key.toString('base64'));
  await writeFile(adminFile, ADMIN.password);
  const base = { DATA_DIR: data, STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, STORAGE: 'json' };

  // 1) 旧版（JSON）运行，写入一段对话
  let app = startApp(base); await app.ready;
  let s = await session(app.base);
  assert.equal(s.status, 200);
  const conv = (await authed(s, '/api/conversations', 'POST', {})).data.conversation.id;
  await authed(s, '/api/conversations/' + conv, 'PATCH', { title: '迁移前的对话' });
  await stop(app);

  // 2) 切到 PostgreSQL：自动迁移，管理员密码文件被清空也不影响（库里已有账号）
  const { url } = await newDatabase();
  await writeFile(adminFile, '');
  const pgEnv = { ...base, STORAGE: 'postgres', DATABASE_URL: url };
  shared = { url, data, keyFile };
  app = startApp(pgEnv); await app.ready;
  assert.match(app.output(), /迁移到 PostgreSQL/);
  s = await session(app.base);
  assert.equal(s.status, 200);
  assert.equal((await authed(s, '/api/conversations/' + conv)).data.conversation.title, '迁移前的对话');
  const created = (await authed(s, '/api/conversations', 'POST', {})).data.conversation.id; // 迁移后的新写入
  await authed(s, '/api/conversations/' + created, 'PATCH', { title: '迁移后的对话' });
  await stop(app);

  // 3) 重启：数据来自 PostgreSQL
  app = startApp(pgEnv); await app.ready;
  s = await session(app.base);
  const list = (await authed(s, '/api/conversations')).data.conversations.map(c => c.title).sort();
  assert.deepEqual(list, ['迁移前的对话', '迁移后的对话']);
  await stop(app);

  // 4) 回退：STORAGE=json 读取镜像出来的 store.json，包含 PostgreSQL 阶段的数据
  app = startApp({ ...base, STORAGE: 'json' }); await app.ready;
  s = await session(app.base);
  assert.deepEqual((await authed(s, '/api/conversations')).data.conversations.map(c => c.title).sort(), ['迁移前的对话', '迁移后的对话']);
  await stop(app);
  assert.ok((await readFile(path.join(data, 'store.json.pre-postgres.bak'))).length > 0);
});

test('服务端：新库没有管理员密码时给出明确提示', async () => {
  const { url } = await newDatabase();
  const keyFile = path.join(dir, 'k2');
  await writeFile(keyFile, key.toString('base64'));
  const app = startApp({ DATA_DIR: path.join(dir, 'empty'), STORE_ENCRYPTION_KEY_FILE: keyFile, DATABASE_URL: url, ADMIN_EMAIL: '' });
  await assert.rejects(app.ready, /install\.sh/);
});

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/db.mjs', ...args], { cwd: root, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; });
    child.on('exit', code => resolve({ code, out }));
  });
}

test('scripts/db.mjs：status、export-json（需 --force）、migrate（库非空需 --force）', async () => {
  const env = { DATABASE_URL: shared.url, STORE_ENCRYPTION_KEY_FILE: shared.keyFile, DATA_DIR: shared.data, STORAGE: 'postgres' };
  const status = await runCli(['status'], env);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /PostgreSQL：已连接/);
  assert.match(status.out, /"conversations":2/);

  const refused = await runCli(['export-json'], env);
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /--force/);
  const exported = await runCli(['export-json', '--force'], env);
  assert.equal(exported.code, 0, exported.out);
  assert.ok((await readFile(path.join(shared.data, 'store.json.before-export.bak'))).length > 0);

  assert.match((await runCli(['migrate'], env)).out, /已经有数据/);
  const migrated = await runCli(['migrate', '--force'], env);
  assert.equal(migrated.code, 0, migrated.out);
  assert.match(migrated.out, /"conversations":2/);
});
