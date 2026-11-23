import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes, createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createZip } from '../ziputil.mjs';
import { inspectUpdateZip, extractUpdateZip, sha256OfFile, parseSha256, sameHash, compareVersions, signRelease, verifySignedUpdateZip } from '../updatepkg.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = (version, name = 'yumeiro-web') => JSON.stringify({ name, version });
const KEY = generateKeyPairSync('ed25519'), OTHER = generateKeyPairSync('ed25519');
const pem = (k, kind) => k[kind].export({ type: kind === 'privateKey' ? 'pkcs8' : 'spki', format: 'pem' });
const base = (version, extra = [], name) => [
  { name: 'Yumeiro/package.json', data: pkg(version, name) }, { name: 'Yumeiro/server.mjs', data: 'console.log(1)' },
  { name: 'Yumeiro/public/index.html', data: '<html></html>' }, { name: 'Yumeiro/deploy/yumeiro-native.sh', data: '#!/bin/bash', mode: 0o100755 }, ...extra];
const unsignedRelease = (version, extra, name) => createZip(base(version, extra, name));
const release = (version, extra, name, key = KEY) => { const list = base(version, extra, name); return createZip([...list, ...signRelease(list, version, pem(key, 'privateKey'))]); };
let pubFile;
test.before(async () => { const d = await mkdtemp(path.join(tmpdir(), 'ymu-key-')); pubFile = path.join(d, 'pub.pem'); await writeFile(pubFile, pem(KEY, 'publicKey')); process.env.YUMEIRO_RELEASE_PUBKEY_FILE = pubFile; });

test('校验值解析：单独的哈希、SHA256.txt 整行、多行里按文件名挑', () => {
  const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64);
  assert.equal(parseSha256(h1.toUpperCase()), h1);
  assert.equal(parseSha256(`${h1} *Yumeiro-0.46.0.zip`, 'Yumeiro-0.46.0.zip'), h1);
  assert.equal(parseSha256(`${h1} *Yumeiro-0.46.0.zip\n${h2} *Yumeiro-0.46.0-with-clients.zip`, 'Yumeiro-0.46.0-with-clients.zip'), h2);
  assert.equal(parseSha256(`${h1} *a.zip\n${h2} *b.zip`, 'c.zip'), '', '多行里找不到这个文件就不猜');
  assert.equal(parseSha256('不是哈希'), '');
  assert.ok(sameHash(h1, h1) && !sameHash(h1, h2) && !sameHash('', ''));
  assert.ok(compareVersions('0.46.0', '0.45.9') > 0 && compareVersions('0.45.4', '0.45.4') === 0);
});

test('发布包检查与解压：只认 Yumeiro 的完整发布包，路径穿越被拒绝', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ymu-')); 
  try {
    const good = path.join(dir, 'good.zip'); await writeFile(good, release('0.46.0', [{ name: 'Yumeiro/Yumeiro-Clients/a.apk', data: randomBytes(1000) }]));
    const info = await inspectUpdateZip(good);
    assert.equal(info.version, '0.46.0'); assert.equal(info.root, 'Yumeiro'); assert.equal(info.withClients, true);
    assert.equal((await sha256OfFile(good)), createHash('sha256').update(await readFile(good)).digest('hex'));
    const out = path.join(dir, 'out'), done = await extractUpdateZip(good, out, info.root);
    assert.equal(JSON.parse(await readFile(path.join(done.dir, 'package.json'), 'utf8')).version, '0.46.0');
    if (process.platform !== 'win32') assert.ok(((await stat(path.join(done.dir, 'deploy/yumeiro-native.sh'))).mode & 0o111) !== 0, '.sh 可执行');

    const bad = async (name, bytes, re) => { const f = path.join(dir, name); await writeFile(f, bytes); await assert.rejects(inspectUpdateZip(f), re); };
    await bad('other.zip', release('1.0.0', [], 'something-else'), /程序名不匹配/);
    await bad('partial.zip', createZip([{ name: 'Yumeiro/package.json', data: pkg('1.0.0') }]), /不完整/);
    await bad('two.zip', createZip([{ name: 'A/package.json', data: pkg('1.0.0') }, { name: 'B/x', data: 'x' }]), /不是 Yumeiro/);
    await bad('junk.zip', Buffer.from('not a zip at all, definitely not'), /zip/);
    const evil = path.join(dir, 'evil.zip'); await writeFile(evil, release('0.46.0', [{ name: 'Yumeiro/../../etc/passwd', data: 'x' }]));
    const evilInfo = await inspectUpdateZip(evil); await extractUpdateZip(evil, path.join(dir, 'out2'), evilInfo.root);
    await assert.rejects(stat(path.join(dir, 'etc')), /ENOENT/, '“..” 路径被忽略，没有写到目录外');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('官方签名：程序自己核实，未签名、被改动、多出文件、别人的签名都被拒绝', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ymu-sig-'));
  try {
    const put = async (name, bytes) => { const f = path.join(dir, name); await writeFile(f, bytes); return f; };
    const good = await put('good.zip', release('0.46.0'));
    assert.deepEqual({ signed: true, version: '0.46.0' }, { signed: (await verifySignedUpdateZip(good)).signed, version: (await verifySignedUpdateZip(good)).version });
    await assert.rejects(verifySignedUpdateZip(await put('unsigned.zip', unsignedRelease('0.46.0'))), /没有官方签名/);
    await assert.rejects(verifySignedUpdateZip(await put('foreign.zip', release('0.46.0', [], undefined, OTHER))), /签名验证失败/);
    // 签名之后改了一个文件 / 多放了一个文件 / 少了一个文件
    const list = base('0.46.0'), sig = signRelease(list, '0.46.0', pem(KEY, 'privateKey'));
    const tampered = list.map(e => e.name.endsWith('server.mjs') ? { ...e, data: 'process.exit(1)//evil' } : e);
    await assert.rejects(verifySignedUpdateZip(await put('tampered.zip', createZip([...tampered, ...sig]))), /不符|被改动/);
    await assert.rejects(verifySignedUpdateZip(await put('extra.zip', createZip([...list, { name: 'Yumeiro/backdoor.mjs', data: 'x' }, ...sig]))), /不一致/);
    await assert.rejects(verifySignedUpdateZip(await put('missing.zip', createZip([...list.filter(e => !e.name.endsWith('index.html')), ...sig]))), /不完整|不一致/);
    // 篡改清单本身（想让清单和被改的文件对得上）也不行：签名对不上
    const forged = JSON.parse(sig[0].data.toString()); forged.files.find(f => f.path === 'server.mjs').sha256 = createHash('sha256').update('process.exit(1)//evil').digest('hex');
    await assert.rejects(verifySignedUpdateZip(await put('forged.zip', createZip([...tampered, { name: sig[0].name, data: JSON.stringify(forged) }, sig[1]]))), /签名验证失败/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('网页更新接口：没有更新助手时拒绝上传并说明原因；校验值格式错误被拒绝', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ymu-srv-')), admin = { email: 'owner@example.com', password: 'a-very-long-test-password' };
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a'); await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, admin.password);
  const port = 20000 + Math.floor(Math.random() * 20000), base = 'http://127.0.0.1:' + port;
  const app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: admin.email, ADMIN_PASSWORD_FILE: adminFile, SETUP_HELPER_TOKEN_FILE: path.join(dir, 'none'), YUMEIRO_RELEASE_PUBKEY_FILE: pubFile } });
  try {
    await new Promise((resolve, reject) => { app.on('exit', c => reject(new Error('exit ' + c))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(admin) });
    const data = await login.json(), auth = { Origin: base, Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': data.csrfToken };
    const status = await (await fetch(base + '/api/admin/service-update/status', { headers: auth })).json();
    assert.equal(status.available, false); assert.match(status.reason, /更新助手/);
    const put = await fetch(base + '/api/admin/service-update/upload', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/zip', 'X-File-Name': 'a.zip' }, body: release('9.9.9') });
    assert.equal(put.status, 409); assert.match((await put.json()).error, /不能在网页里更新/);
    const apply = await fetch(base + '/api/admin/service-update/apply', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    assert.equal(apply.status, 404, '没有上传过就不能更新');
    const anon = await fetch(base + '/api/admin/service-update/status');
    assert.equal(anon.status, 401);
  } finally { app.removeAllListeners('exit'); app.kill(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
});

test('网页更新流程（模拟更新助手）：签名不对直接拒绝并删除；签名验证通过才能更新', async () => {
  const http = (await import('node:http')).default, { readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'ymu-flow-')), admin = { email: 'owner@example.com', password: 'a-very-long-test-password' };
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a'), tokenFile = path.join(dir, 'helper-token'), sock = process.platform === 'win32' ? (B => B + B + '.' + B + 'pipe' + B + 'ymu-' + randomBytes(6).toString('hex'))(String.fromCharCode(92)) : path.join(dir, 'h.sock');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, admin.password); await writeFile(tokenFile, 'helper-token-0123456789');
  const calls = [];
  const helper = http.createServer((req, res) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { const body = JSON.parse(raw); calls.push(body); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: body.action === 'apply_update' ? '更新已开始' : 'ok', details: { state: 'idle' } })); }); });
  await new Promise(r => helper.listen(sock, r));
  const port = 20000 + Math.floor(Math.random() * 20000), base = 'http://127.0.0.1:' + port;
  const app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: admin.email, ADMIN_PASSWORD_FILE: adminFile, SETUP_HELPER_SOCKET: sock, SETUP_HELPER_TOKEN_FILE: tokenFile, YUMEIRO_RELEASE_PUBKEY_FILE: pubFile } });
  try {
    await new Promise((resolve, reject) => { app.on('exit', c => reject(new Error('exit ' + c))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(admin) });
    const data = await login.json(), auth = { Origin: base, Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': data.csrfToken };
    const zip = release('99.0.0'), real = createHash('sha256').update(zip).digest('hex');
    const upload = (body, name = 'Yumeiro-99.0.0.zip') => fetch(base + '/api/admin/service-update/upload', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/zip', 'X-File-Name': name }, body });
    const apply = body => fetch(base + '/api/admin/service-update/apply', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const zips = async () => (await readdir(path.join(dir, 'updates'))).filter(n => n.endsWith('.zip'));
    // 没签名 / 别人签的 / 被改过：直接拒绝并删除，助手完全没被调用
    for (const bad of [unsignedRelease('99.0.0'), release('99.0.0', [], undefined, OTHER)]) {
      const r = await upload(bad); assert.equal(r.status, 400); assert.equal((await r.json()).rejected, true); assert.deepEqual(await zips(), []);
    }
    const ok = await upload(zip); const okBody = await ok.json();
    assert.equal(ok.status, 200); assert.equal(okBody.pending.version, '99.0.0'); assert.equal(okBody.pending.newer, true); assert.equal(okBody.pending.sha256, real); assert.equal(okBody.pending.signed, true);
    assert.equal((await apply({})).status, 400, '没有确认');
    assert.equal(calls.filter(c => c.action === 'apply_update').length, 0, '没确认之前助手没有被调用');
    const go = await apply({ confirm: true }); assert.equal(go.status, 202);
    const sent = calls.find(c => c.action === 'apply_update');
    assert.equal(sent.options.update.sha256, real); assert.match(sent.options.update.file, /^incoming-[0-9a-f-]{36}\.zip$/);
    assert.equal((await apply({ confirm: true })).status, 404, '开始更新后待更新文件已交给助手');
    // 同版本 / 更低版本：需要明确允许降级
    assert.equal((await upload(release('0.0.1'))).status, 200);
    assert.equal((await apply({ confirm: true })).status, 400, '不高于当前版本，需要允许降级');
  } finally { app.removeAllListeners('exit'); app.kill(); helper.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
});

test('Docker 部署：配置了 UPDATER_URL 时通过更新器（带令牌）查询与上传；更新器不可达时说明原因', async () => {
  const http = (await import('node:http')).default;
  const dir = await mkdtemp(path.join(tmpdir(), 'ymu-dk-')), admin = { email: 'owner@example.com', password: 'a-very-long-test-password' };
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a'), tokenFile = path.join(dir, 'ut');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, admin.password); await writeFile(tokenFile, 'updater-token-0123456789abcdef');
  const seen = [];
  const fake = http.createServer((req, res) => { let raw = ''; req.on('data', c => raw += c); req.on('end', () => { seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: 'ok', details: { state: 'idle' } })); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const spawnApp = async url => {
    const port = 20000 + Math.floor(Math.random() * 20000), base = 'http://127.0.0.1:' + port;
    const app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: admin.email, ADMIN_PASSWORD_FILE: adminFile, UPDATER_URL: url, UPDATER_TOKEN_FILE: tokenFile, YUMEIRO_RELEASE_PUBKEY_FILE: pubFile } });
    await new Promise((resolve, reject) => { app.on('exit', c => reject(new Error('exit ' + c))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(admin) });
    const data = await login.json();
    return { app, base, auth: { Origin: base, Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': data.csrfToken } };
  };
  let one;
  try {
    one = await spawnApp('http://127.0.0.1:' + fake.address().port);
    const status = await (await fetch(one.base + '/api/admin/service-update/status', { headers: one.auth })).json();
    assert.equal(status.available, true); assert.equal(seen.at(-1).auth, 'Bearer updater-token-0123456789abcdef'); assert.equal(seen.at(-1).body.action, 'update_status');
    const up = await fetch(one.base + '/api/admin/service-update/upload', { method: 'PUT', headers: { ...one.auth, 'Content-Type': 'application/zip', 'X-File-Name': 'a.zip' }, body: unsignedRelease('99.0.0') });
    assert.equal(up.status, 400, '未签名的包在网页这一侧就被拒绝，更新器完全没收到');
    assert.equal(seen.filter(x => x.body.action === 'apply_update').length, 0);
    one.app.removeAllListeners('exit'); one.app.kill(); await new Promise(r => setTimeout(r, 300));
    one = await spawnApp('http://127.0.0.1:1');
    const down = await (await fetch(one.base + '/api/admin/service-update/status', { headers: one.auth })).json();
    assert.equal(down.available, false); assert.match(down.reason, /更新器没有运行/);
  } finally { if (one) { one.app.removeAllListeners('exit'); one.app.kill(); } fake.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
});
