import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeProvider } from '../providers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('读取服务商模型列表里的价格：每 Token 美元换算成每百万；没有价格或无效的忽略', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ data: [
    { id: 'a/m1', pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'a/free', pricing: { prompt: '0', completion: '0' } },
    { id: 'a/bad', pricing: { prompt: 'abc', completion: '1' } },
    { id: 'a/neg', pricing: { prompt: '-1', completion: '1' } },
    { id: 'a/none' },
  ] }) });
  const r = await probeProvider({ baseUrl: 'https://x.test/v1', apiKey: 'k' }, fake);
  assert.deepEqual(r.prices, { 'a/m1': { input: 3, output: 15, currency: '$' } });
  assert.equal(r.models.length, 5);
});

test('服务器：每个模型可以有自己的货币，按汇率折算成统计货币；没填汇率会提示', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-price-'));
  const keyFile = path.join(dir, 'k'); await writeFile(keyFile, randomBytes(32).toString('base64'));
  const upstream = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 } })); }); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const ADMIN = { email: 'owner@corp.com', password: 'a-very-long-test-password' };
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: await mkdtemp(path.join(dir, 'd-')), COOKIE_SECURE: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.on('exit', c => reject(new Error('exit ' + c))); child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const url = 'http://127.0.0.1:' + port;
  const lr = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(ADMIN) }); const ld = await lr.json();
  const auth = { cookie: lr.headers.get('set-cookie').split(';')[0], csrf: ld.csrfToken };
  const call = async (p, method = 'GET', body) => { const r = await fetch(url + p, { method, headers: { Origin: url, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  try {
    const created = await call('/api/admin/providers', 'POST', { name: '测试', template: 'custom', baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1', apiKey: 'sk-test-upstream-key-1234567890', models: ['m1'], membersAllowed: true });
    const ref = created.data.provider.slug + '/m1';
    // 美元计价、统计货币是人民币，但还没填汇率 → 提示缺汇率
    assert.equal((await call('/api/admin/pricing', 'PUT', { currency: '¥', models: { [ref]: { input: 2, output: 0, currency: '$' } } })).status, 200);
    let p = (await call('/api/admin/pricing')).data;
    assert.deepEqual(p.missingRates, ['$']); assert.equal(p.models.find(m => m.ref === ref).price.currency, '$');
    // 填了汇率 1$=7¥：100 万输入 Token × 2 美元 = 14 元
    assert.equal((await call('/api/admin/pricing', 'PUT', { currency: '¥', models: { [ref]: { input: 2, output: 0, currency: '$' } }, rates: { $: 7, bad: -1, x: 'abc' } })).status, 200);
    p = (await call('/api/admin/pricing')).data; assert.deepEqual(p.missingRates, []); assert.deepEqual(p.rates, { $: 7 });
    const conv = (await call('/api/conversations', 'POST', { model: ref })).data.conversation.id;
    assert.equal((await call('/api/chat', 'POST', { conversation_id: conv, message: 'hi' })).status, 200);
    await new Promise(r => setTimeout(r, 200));
    const month = (await call('/api/admin/security')).data.costs.month; assert.ok(Math.abs(month - 14) < 1e-6, '折算后费用应为 14，实际 ' + month);
    // 同货币不折算
    await call('/api/admin/pricing', 'PUT', { currency: '$', models: { [ref]: { input: 2, output: 0, currency: '$' } }, rates: { $: 7 } });
    assert.equal((await call('/api/admin/pricing')).data.missingRates.length, 0);
    // 读取价格：这个测试上游没有价格，应提示手动填写而不是报错
    const sync = await call('/api/admin/pricing/sync', 'POST', {}); assert.equal(sync.status, 200); assert.deepEqual(sync.data.prices, {});
  } finally { child.removeAllListeners('exit'); child.kill(); upstream.close(); await new Promise(r => setTimeout(r, 200)); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
});
