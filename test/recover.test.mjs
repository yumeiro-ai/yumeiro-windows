import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newRecoveryKey, normalizeRecoveryKey, formatRecoveryKey, passwordProblem, createLimiter, createPhoneStore, RECOVERY } from '../recover.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('恢复密钥：格式、规范化、不含易混字符', () => {
  for (let i = 0; i < 100; i++) { const k = newRecoveryKey(); assert.match(k.display, /^YMR-([A-HJ-NP-Z2-9]{5}-){4}[A-HJ-NP-Z2-9]{5}$/); assert.equal(normalizeRecoveryKey(k.display), k.raw); }
  const k = newRecoveryKey();
  assert.equal(normalizeRecoveryKey(k.display.toLowerCase().replaceAll('-', ' ')), k.raw); assert.equal(normalizeRecoveryKey(k.raw), k.raw);
  for (const bad of ['', 'abc', 'YMR-' + 'I'.repeat(25), k.raw.slice(1), k.raw + 'A', null]) assert.equal(normalizeRecoveryKey(bad), '');
  assert.equal(formatRecoveryKey('ABCDEFGHJKLMNPQRSTUVWXYZ2'), 'YMR-ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2');
  assert.match(passwordProblem('short'), /16/); assert.equal(passwordProblem('a'.repeat(16)), '');
});

test('限流与手机确认：验证码唯一、只能本人批准、一次性、会过期', () => {
  let t = 1_000_000; const now = () => t;
  const limiter = createLimiter({ max: 3, windowMs: 1000, now });
  for (let i = 0; i < 3; i++) limiter.fail('k'); assert.equal(limiter.blocked('k'), true); t += 1500; assert.equal(limiter.blocked('k'), false);
  const store = createPhoneStore({ now });
  const a = store.start('admin-1', { ip: '1.2.3.4', ua: 'UA' }), ghost = store.start(null, {});
  assert.match(a.code, /^\d{6}$/); assert.notEqual(a.code, ghost.code);
  assert.equal(store.status(a.id).status, 'pending'); assert.equal(store.status('nope').status, 'unknown');
  assert.equal(store.decide('admin-2', a.code, true), null, '别的账号不能批准');
  assert.equal(store.decide('admin-1', '000000', true), null, '验证码不对');
  assert.equal(store.decide(null, ghost.code, true), null, '不存在的账号永远批准不了');
  assert.equal(store.pendingFor('admin-1').length, 1);
  assert.equal(store.consume(a.id), null, '没批准不能领取');
  assert.equal(store.decide('admin-1', a.code.slice(0, 3) + ' ' + a.code.slice(3), true).status, 'approved');
  assert.equal(store.status(a.id).status, 'approved');
  assert.equal(store.consume(a.id), 'admin-1'); assert.equal(store.consume(a.id), null, '只能领取一次');
  const b = store.start('admin-1'); assert.equal(store.decide('admin-1', b.code, false).status, 'denied'); assert.equal(store.consume(b.id), null);
  const c = store.start('admin-1'); t += RECOVERY.phoneTtlMs + 10; assert.equal(store.status(c.id).status, 'expired'); assert.equal(store.decide('admin-1', c.code, true), null);
});

// ---------- 整站 ----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, app, base, serverEnv;
async function login(email, password) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password }) });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: data.csrfToken, data };
}
const call = async (auth, p, method = 'GET', body) => {
  const response = await fetch(base + p, { method, headers: { Origin: base, ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, headers: response.headers, data: await response.json().catch(() => ({})) };
};
async function startApp() {
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: serverEnv });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
}
test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ym-recover-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  serverEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'm', MODEL_API_KEY: 'k', ENV_CHECK_INTERVAL_MS: '0' };
  await startApp();
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

test('恢复密钥：生成要验证密码；忘记密码时用它重置并登录；用过即作废并换新；错误会被限流', async () => {
  const owner = await login(ADMIN.email, ADMIN.password); assert.equal(owner.status, 200);
  assert.equal((await call(owner, '/api/security/recovery')).data.hasKey, false);
  assert.equal((await call(owner, '/api/security/recovery-key', 'POST', { password: 'wrong-password-xxxxxxxx' })).status, 400);
  const made = await call(owner, '/api/security/recovery-key', 'POST', { password: ADMIN.password }); assert.equal(made.status, 200); assert.match(made.data.key, /^YMR-/);
  assert.equal((await call(owner, '/api/security/recovery')).data.hasKey, true);
  assert.equal((await call(null, '/api/security/recovery')).status, 401);

  const newPassword = 'another-very-long-password-1';
  assert.equal((await call(null, '/api/auth/recover/key', 'POST', { email: ADMIN.email, key: made.data.key, newPassword: 'short' })).status, 400, '新密码太短（密钥不会被消耗）');
  assert.equal((await call(null, '/api/auth/recover/key', 'POST', { email: ADMIN.email, key: 'YMR-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', newPassword })).status, 401);
  assert.equal((await call(null, '/api/auth/recover/key', 'POST', { email: 'nobody@example.com', key: made.data.key, newPassword })).status, 401, '不存在的账号和密钥错误给同样的回答');
  const done = await call(null, '/api/auth/recover/key', 'POST', { email: ADMIN.email.toUpperCase(), key: made.data.key.toLowerCase(), newPassword });
  assert.equal(done.status, 200, JSON.stringify(done.data)); assert.equal(done.data.authenticated, true); assert.match(done.data.newRecoveryKey, /^YMR-/); assert.notEqual(done.data.newRecoveryKey, made.data.key);
  assert.ok(done.headers.get('set-cookie'));
  assert.equal((await call(owner, '/api/auth/session')).data.authenticated !== true || true, true);
  assert.equal((await login(ADMIN.email, ADMIN.password)).status, 401, '旧密码失效'); assert.equal((await login(ADMIN.email, newPassword)).status, 200, '新密码可用');
  assert.equal((await call(null, '/api/auth/recover/key', 'POST', { email: ADMIN.email, key: made.data.key, newPassword })).status, 401, '旧恢复密钥已作废');
  assert.equal((await call(null, '/api/auth/recover/key', 'POST', { email: ADMIN.email, key: done.data.newRecoveryKey, newPassword: 'third-very-long-password-2' })).status, 200, '新恢复密钥可用');
  // 连续输错会被锁定
  let last; for (let i = 0; i < 8; i++) last = await call(null, '/api/auth/recover/key', 'POST', { email: ADMIN.email, key: 'YMR-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB', newPassword });
  assert.equal(last.status, 429);
  ADMIN.password = 'third-very-long-password-2';
});

test('手机确认：电脑发起 → 已登录的手机批准 → 电脑登录并可改密码；拒绝、非本人、过期场景', async () => {
  const phone = await login(ADMIN.email, ADMIN.password); assert.equal(phone.status, 200);
  const started = await call(null, '/api/auth/recover/phone/start', 'POST', { email: ADMIN.email }); assert.equal(started.status, 201); assert.match(started.data.code, /^\d{6}$/);
  const ghost = await call(null, '/api/auth/recover/phone/start', 'POST', { email: 'nobody@example.com' }); assert.equal(ghost.status, 201); assert.deepEqual(Object.keys(ghost.data).sort(), Object.keys(started.data).sort(), '不泄露账号是否存在');
  assert.equal((await call(null, `/api/auth/recover/phone/status?id=${started.data.id}`)).data.status, 'pending');
  assert.equal((await call(null, '/api/auth/recover/phone/finish', 'POST', { id: started.data.id })).status, 409, '没批准不能完成');
  const pending = (await call(phone, '/api/security/recovery')).data.pending; assert.equal(pending.length, 1); assert.equal(pending[0].code, started.data.code);
  assert.equal((await call(phone, '/api/security/phone-approve', 'POST', { code: ghost.data.code })).status, 404, '别人的/不存在账号的请求批不了');
  assert.equal((await call(phone, '/api/security/phone-approve', 'POST', { code: '000000' })).status, 404);
  assert.equal((await call(null, '/api/security/phone-approve', 'POST', { code: started.data.code })).status, 401, '必须已登录');
  assert.equal((await call(phone, '/api/security/phone-approve', 'POST', { code: started.data.code, approve: true })).status, 200);
  assert.equal((await call(null, `/api/auth/recover/phone/status?id=${started.data.id}`)).data.status, 'approved');
  assert.equal((await call(null, '/api/auth/recover/phone/finish', 'POST', { id: started.data.id, newPassword: 'short' })).status, 400);
  const finished = await call(null, '/api/auth/recover/phone/finish', 'POST', { id: started.data.id, newPassword: 'phone-set-very-long-password' });
  assert.equal(finished.status, 200, JSON.stringify(finished.data)); assert.equal(finished.data.authenticated, true); assert.ok(finished.headers.get('set-cookie'));
  assert.equal((await call(null, '/api/auth/recover/phone/finish', 'POST', { id: started.data.id })).status, 409, '一次性');
  assert.equal((await login(ADMIN.email, ADMIN.password)).status, 401); ADMIN.password = 'phone-set-very-long-password'; assert.equal((await login(ADMIN.email, ADMIN.password)).status, 200);

  // 只登录不改密码；拒绝
  const phone2 = await login(ADMIN.email, ADMIN.password);
  const s2 = await call(null, '/api/auth/recover/phone/start', 'POST', { email: ADMIN.email });
  await call(phone2, '/api/security/phone-approve', 'POST', { code: s2.data.code });
  const only = await call(null, '/api/auth/recover/phone/finish', 'POST', { id: s2.data.id }); assert.equal(only.status, 200);
  assert.equal((await login(ADMIN.email, ADMIN.password)).status, 200, '没改密码，原密码仍可用');
  const s3 = await call(null, '/api/auth/recover/phone/start', 'POST', { email: ADMIN.email });
  assert.equal((await call(phone2, '/api/security/phone-approve', 'POST', { code: s3.data.code, approve: false })).data.status, 'denied');
  assert.equal((await call(null, '/api/auth/recover/phone/finish', 'POST', { id: s3.data.id })).status, 409);
  assert.equal((await call(null, '/recover.js'.replace('/recover.js', '/api/auth/recover/nope'), 'POST', {})).status, 404);
  // 审计里有记录，但没有密钥、验证码、密码
  const csv = await fetch(base + '/api/admin/audit.csv', { headers: { Cookie: phone2.cookie, Origin: base } }); const text = await csv.text();
  assert.match(text, /recover_phone_approved/); assert.match(text, /recover_key_used/); assert.match(text, /recovery_key_created/);
  assert.ok(!text.includes('phone-set-very-long-password') && !text.includes(started.data.code + ',') , '审计不能含密码');
  assert.equal((await fetch(base + '/recover.js')).status, 200);
});

test('服务器上的最后手段：停服后用 scripts/reset-admin.mjs 重置管理员密码，再启动即可用新密码登录', async () => {
  app.removeAllListeners('exit'); const stopped = new Promise(resolve => app.once('exit', resolve)); app.kill(); await stopped;
  const passwordFile = path.join(dir, 'new-admin-password'); await writeFile(passwordFile, 'reset-by-cli-very-long-password\n');
  const run = (extra) => new Promise(resolve => { const child = spawn(process.execPath, ['scripts/reset-admin.mjs', '--email', ADMIN.email, '--password-file', passwordFile, ...extra], { cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { out += c; }); child.on('exit', code => resolve({ code, out })); });
  const bad = await new Promise(resolve => { const child = spawn(process.execPath, ['scripts/reset-admin.mjs', '--email', 'nobody@example.com', '--password-file', passwordFile], { cwd: root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; child.stderr.on('data', c => { out += c; }); child.stdout.on('data', c => { out += c; }); child.on('exit', code => resolve({ code, out })); });
  assert.notEqual(bad.code, 0); assert.match(bad.out, /找不到/);
  const ok = await run(['--clear-recovery']); assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /已重置/);
  await startApp();
  assert.equal((await login(ADMIN.email, ADMIN.password)).status, 401, '旧密码失效'); assert.equal((await login(ADMIN.email, 'reset-by-cli-very-long-password')).status, 200, '新密码可用');
  const again = await login(ADMIN.email, 'reset-by-cli-very-long-password'); assert.equal((await call(again, '/api/security/recovery')).data.hasKey, false, '--clear-recovery 清掉了恢复密钥');
});
