import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS, FEATURES, PLAN_ENFORCEMENT, featureAllowed, verifyLicense, effectivePlan, normalizeEmailPolicy, validateEmailPolicyInput, emailAllowed, LICENSE_PREFIX } from '../plans.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pair = generateKeyPairSync('ed25519');
const pubPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const mint = (payload, key = pair.privateKey) => { const body = LICENSE_PREFIX + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url'); return body + '.' + sign(null, Buffer.from(body), key).toString('base64url'); };
const lic = (over = {}) => ({ v: 1, id: 'abc123', tier: 'pro', org: '测试公司', seats: 50, iat: 1, exp: 0, ...over });

test('试用期不加锁：所有功能一律可用；打开加锁后才按档位判断', () => {
  assert.equal(PLAN_ENFORCEMENT, false, '试用期：发版前不要打开加锁');
  for (const f of FEATURES) assert.equal(featureAllowed(f.id, 'free'), true, f.id);
  assert.equal(featureAllowed('dlp', 'free', true), false);
  assert.equal(featureAllowed('dlp', 'team', true), false);
  assert.equal(featureAllowed('dlp', 'pro', true), true);
  assert.equal(featureAllowed('confidential', 'pro', true), false);
  assert.equal(featureAllowed('confidential', 'business', true), true);
  assert.equal(featureAllowed('chat', 'free', true), true);
  assert.equal(featureAllowed('不存在', 'business', true), false);
});
test('档位表合理：四档、功能都挂在有效档位上', () => {
  assert.deepEqual(TIERS.map(t => t.id), ['free', 'team', 'pro', 'business']);
  for (const f of FEATURES) assert.ok(TIERS.some(t => t.id === f.tier), f.id);
  assert.equal(new Set(FEATURES.map(f => f.id)).size, FEATURES.length);
});
test('授权密钥：签名对、没过期才生效；被改过、过期、格式错都不认', () => {
  const good = mint(lic());
  const r = verifyLicense(good, 1000, pubPem); assert.equal(r.ok, true); assert.equal(r.license.tier, 'pro'); assert.equal(r.expired, false);
  assert.equal(effectivePlan(good, 1000, pubPem).tier, 'pro');
  const [h, body, sig] = good.split('.');
  const forged = h + '.' + Buffer.from(JSON.stringify(lic({ tier: 'business' }))).toString('base64url') + '.' + sig;
  assert.equal(verifyLicense(forged, 1000, pubPem).ok, false, '改了档位签名就对不上');
  const other = generateKeyPairSync('ed25519').privateKey;
  assert.equal(verifyLicense(mint(lic(), other), 1000, pubPem).ok, false, '别人的私钥签的不认');
  const old = mint(lic({ exp: 5000 }));
  assert.equal(verifyLicense(old, 6000, pubPem).expired, true); assert.equal(effectivePlan(old, 6000, pubPem).tier, 'free');
  for (const bad of ['', 'abc', 'YML1.x', 'XXXX.' + body + '.' + sig, mint(lic({ tier: 'god' })), mint(lic({ id: 5 }))]) assert.equal(verifyLicense(bad, 1000, pubPem).ok, false, bad.slice(0, 20));
  assert.equal(effectivePlan('', 1, pubPem).tier, 'free');
});
test('邮箱域名限制：完整匹配，不被相似域名绕过；没开就全放行', () => {
  const p = normalizeEmailPolicy({ enabled: true, domains: 'Example.com, @corp.cn\nexample.com' });
  assert.deepEqual(p.domains, ['example.com', 'corp.cn']);
  assert.equal(emailAllowed('a@example.com', p), true); assert.equal(emailAllowed('A@EXAMPLE.COM', p), true);
  for (const e of ['a@evil-example.com', 'a@example.com.evil.net', 'a@sub.example.com', 'a@@example.com', 'example.com', '', null]) assert.equal(emailAllowed(e, p), false, String(e));
  assert.equal(emailAllowed('x@anything.org', normalizeEmailPolicy({ enabled: false, domains: ['example.com'] })), true);
  assert.equal(normalizeEmailPolicy({ enabled: true, domains: [] }).enabled, false, '没填域名不会把所有人都锁在外面');
  assert.match(validateEmailPolicyInput({ enabled: true, domains: 'not a domain!' }), /域名格式/);
  assert.match(validateEmailPolicyInput({ enabled: true, domains: '' }), /至少填写/);
  assert.equal(validateEmailPolicyInput({ enabled: true, domains: 'a.com' }), '');
});

test('签发脚本：签出来的密钥能被验证', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-lic-')); const keyFile = path.join(dir, 'k.pem');
  try {
    await writeFile(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const r = spawnSync(process.execPath, ['scripts/make-license.mjs', '--key', keyFile, '--tier', 'team', '--org', '某某公司', '--days', '30'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const v = verifyLicense(r.stdout.trim(), Date.now(), pubPem); assert.equal(v.ok, true); assert.equal(v.license.tier, 'team'); assert.ok(v.license.exp > Date.now());
    assert.notEqual(spawnSync(process.execPath, ['scripts/make-license.mjs', '--key', keyFile, '--tier', 'x'], { cwd: root }).status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('服务器：邮箱域名限制作用于邀请和新建成员；套餐页与授权激活', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-plan-'));
  const keyFile = path.join(dir, 'k'); await writeFile(keyFile, randomBytes(32).toString('base64'));
  const ADMIN = { email: 'owner@corp.com', password: 'a-very-long-test-password' };
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: await mkdtemp(path.join(dir, 'd-')), COOKIE_SECURE: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.on('exit', c => reject(new Error('exit ' + c))); child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const base = 'http://127.0.0.1:' + port;
  const lr = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(ADMIN) }); const ld = await lr.json();
  const auth = { cookie: lr.headers.get('set-cookie').split(';')[0], csrf: ld.csrfToken };
  const call = async (p, method = 'GET', body, a = auth) => { const r = await fetch(base + p, { method, headers: { Origin: base, Cookie: a.cookie, 'X-CSRF-Token': a.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  try {
    // 没开限制：任何邮箱都能建
    assert.equal((await call('/api/admin/members', 'POST', { email: 'old@gmail.com', password: 'member-password-12345' })).status, 201);
    assert.equal((await call('/api/admin/security', 'PUT', { emailDomains: { enabled: true, domains: 'bad domain' } })).status, 400);
    assert.equal((await call('/api/admin/security', 'PUT', { emailDomains: { enabled: true, domains: 'corp.com' } })).status, 200);
    assert.deepEqual((await call('/api/admin/security')).data.emailDomains, { enabled: true, domains: ['corp.com'] });
    let r = await call('/api/admin/members', 'POST', { email: 'x@gmail.com', password: 'member-password-12345' });
    assert.equal(r.status, 400); assert.match(r.data.error, /@corp\.com/);
    assert.equal((await call('/api/admin/members', 'POST', { email: 'ok@corp.com', password: 'member-password-12345' })).status, 201);
    assert.equal((await call('/api/admin/invites', 'POST', { email: 'x@gmail.com' })).status, 400);
    // 邀请链接没指定邮箱：注册时的邮箱也要符合
    const inv = (await call('/api/admin/invites', 'POST', { note: 't' })).data.invite;
    const reg = email => fetch(base + '/api/invite/' + inv.token + '/accept', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password: 'member-password-67890' }) });
    assert.equal((await reg('x@gmail.com')).status, 403);
    assert.equal((await reg('new@corp.com')).status, 201);
    // 套餐页
    const plan = (await call('/api/admin/plan')).data;
    assert.equal(plan.enforced, false); assert.equal(plan.tier, 'free'); assert.equal(plan.tiers.length, 4); assert.ok(plan.features.length > 5);
    assert.equal(plan.source, 'none');
    assert.equal((await call('/api/admin/plan/tier', 'PUT', { tier: 'god' })).status, 400);
    assert.equal((await call('/api/admin/plan/tier', 'PUT', { tier: 'pro' })).status, 200);
    const after = (await call('/api/admin/plan')).data; assert.equal(after.tier, 'pro'); assert.equal(after.source, 'trial'); assert.equal(after.enforced, false);
    assert.equal((await call('/api/admin/plan/purchase', 'PUT', { url: 'https://x.com' })).status, 404, '购买地址设置已移除');
    assert.equal((await call('/api/admin/plan/license', 'POST', { key: 'YML1.bad.bad' })).status, 400);
    assert.equal((await call('/api/admin/plan/license', 'POST', { key: '' })).status, 400);
    // 普通成员不能看
    const m = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'ok@corp.com', password: 'member-password-12345' }) });
    const md = await m.json(); const member = { cookie: m.headers.get('set-cookie').split(';')[0], csrf: md.csrfToken };
    assert.equal((await call('/api/admin/plan', 'GET', undefined, member)).status, 403);
    assert.equal((await call('/api/admin/plan/license', 'POST', { key: 'x' }, member)).status, 403);
    assert.equal((await call('/api/admin/plan/tier', 'PUT', { tier: 'free' }, member)).status, 403);
  } finally { child.removeAllListeners('exit'); child.kill(); await new Promise(r2 => setTimeout(r2, 200)); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
});
