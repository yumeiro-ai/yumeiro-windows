import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { createZip } from '../ziputil.mjs';
import { signRelease } from '../updatepkg.mjs';
import { createUpdater, startServer } from '../docker/updater/updater.mjs';

const KEY = generateKeyPairSync('ed25519'), OTHER = generateKeyPairSync('ed25519');
const pem = (k, kind) => k[kind].export({ type: kind === 'privateKey' ? 'pkcs8' : 'spki', format: 'pem' });
const pkg = version => JSON.stringify({ name: 'yumeiro-web', version });
const release = (version, key = KEY) => {
  const list = ['server.mjs', 'public/index.html', 'deploy/yumeiro-native.sh', 'docker/updater/updater.mjs'].map(n => ({ name: 'Yumeiro/' + n, data: 'v' + version + ':' + n })).concat({ name: 'Yumeiro/package.json', data: pkg(version) });
  return createZip([...list, ...signRelease(list, version, pem(key, 'privateKey'))]);
};
let pubDir;
test.before(async () => { pubDir = await mkdtemp(path.join(tmpdir(), 'ymu-pub-')); await writeFile(path.join(pubDir, 'p.pem'), pem(KEY, 'publicKey')); process.env.YUMEIRO_RELEASE_PUBKEY_FILE = path.join(pubDir, 'p.pem'); });

async function setup(healthy) {
  const base = await mkdtemp(path.join(tmpdir(), 'ymu-dock-')), project = path.join(base, 'Yumeiro'), data = path.join(base, 'data');
  await mkdir(path.join(project, 'secrets'), { recursive: true }); await mkdir(path.join(project, 'public'), { recursive: true }); await mkdir(path.join(data, 'updates'), { recursive: true });
  await writeFile(path.join(project, 'package.json'), pkg('0.45.0')); await writeFile(path.join(project, '.env'), 'COMPOSE_FILE=docker-compose.yml\n'); await writeFile(path.join(project, 'secrets', 'k'), 'secret'); await writeFile(path.join(project, 'server.mjs'), 'OLD');
  const calls = []; let ups = 0;
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'tar' && args[0] === 'czf') await writeFile(args[1], 'tar');
    if (args[0] === 'compose' && args[1] === 'up') ups++;
    if (args[0] === 'compose' && args[1] === 'ps' && args[2] === '-q') return { code: 0, out: 'abc123\n' };
    if (args[0] === 'compose' && args[1] === 'ps') return { code: 0, out: 'yumeiro\npostgres\n' };
    if (cmd === 'docker' && args[0] === 'inspect') return { code: 0, out: (healthy(ups) ? 'healthy' : 'unhealthy') + '\n' };
    return { code: 0, out: '' };
  };
  let exited = 0;
  const updater = createUpdater({ projectDir: project, dataDir: data, exec, healthTimeoutMs: 300, pollMs: 20, exitAfterSuccess: () => { exited++; } });
  const put = async bytes => { const file = 'incoming-' + randomUUID() + '.zip'; await writeFile(path.join(data, 'updates', file), bytes); return { file, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const done = async () => { for (let i = 0; i < 100; i++) { const st = await updater.readStatus(); if (st.state === 'ok' || st.state === 'failed') return st; await new Promise(r => setTimeout(r, 30)); } throw new Error('更新没有结束'); };
  return { base, project, data, calls, updater, put, done, exited: () => exited };
}

test('Docker 更新器：验签 → 备份 → 替换程序文件 → 重建 → 健康；.env 和 secrets 不动', async () => {
  const t = await setup(() => true);
  try {
    const up = await t.put(release('0.46.0'));
    const r = await t.updater.handle({ action: 'apply_update', options: { update: up } });
    assert.equal(r.details.version, '0.46.0');
    const st = await t.done(); assert.equal(st.state, 'ok', st.log);
    assert.equal(await readFile(path.join(t.project, 'server.mjs'), 'utf8'), 'v0.46.0:server.mjs');
    assert.equal(JSON.parse(await readFile(path.join(t.project, 'package.json'), 'utf8')).version, '0.46.0');
    assert.equal(await readFile(path.join(t.project, '.env'), 'utf8'), 'COMPOSE_FILE=docker-compose.yml\n');
    assert.equal(await readFile(path.join(t.project, 'secrets', 'k'), 'utf8'), 'secret');
    assert.ok(t.calls.some(c => /^docker compose up -d --build --no-deps yumeiro$/.test(c)), '只重建 yumeiro 服务，不动 updater 自己和数据库');
    const backups = await readdir(path.join(t.project, 'backups')); assert.ok(backups.some(n => n.startsWith('code-')) && backups.some(n => n.startsWith('data-')));
    assert.ok(t.calls.some(c => /pg_dump|postgres/.test(c)), '有内置数据库时一并备份');
    assert.deepEqual((await readdir(path.join(t.data, 'updates'))).filter(n => n.endsWith('.zip')), [], '上传的压缩包已清理');
    await new Promise(r => setTimeout(r, 20)); assert.equal(t.exited(), 1, '成功后让自己重启以加载新版更新器');
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('Docker 更新器：新版本没起来 → 恢复旧程序文件并重建，状态为失败', async () => {
  const t = await setup(ups => ups >= 2); // 第一次重建后不健康，回滚重建后健康
  try {
    await t.updater.handle({ action: 'apply_update', options: { update: await t.put(release('0.46.0')) } });
    const st = await t.done(); assert.equal(st.state, 'failed'); assert.match(st.log, /已回滚到旧版本/);
    assert.equal(t.calls.filter(c => /compose up -d --build --no-deps yumeiro/.test(c)).length, 2);
    assert.ok(t.calls.some(c => /^tar xzf .*code-0\.45\.0/.test(c)), '用升级前的程序文件备份恢复');
    assert.equal(t.exited(), 0);
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('Docker 更新器：拒绝未签名 / 别人签名 / 被改动 / 同版本 / 无效请求，且不动任何文件', async () => {
  const t = await setup(() => true);
  try {
    const list = [{ name: 'Yumeiro/package.json', data: pkg('0.46.0') }, { name: 'Yumeiro/server.mjs', data: 'x' }, { name: 'Yumeiro/public/index.html', data: 'x' }, { name: 'Yumeiro/deploy/yumeiro-native.sh', data: 'x' }];
    const sigs = signRelease(list, '0.46.0', pem(KEY, 'privateKey'));
    const reject = async (bytes, re, opts = {}) => { await assert.rejects(t.updater.handle({ action: 'apply_update', options: { update: { ...(await t.put(bytes)), ...opts } } }), re); };
    await reject(createZip(list), /没有官方签名/);
    await reject(release('0.46.0', OTHER), /签名验证失败/);
    await reject(createZip([...list.map(e => e.name.endsWith('server.mjs') ? { ...e, data: 'evil' } : e), ...sigs]), /不符|被改动/);
    await reject(release('0.45.0'), /不高于当前版本/);
    await reject(release('0.46.0'), /被改动过/, { sha256: 'a'.repeat(64) });
    await assert.rejects(t.updater.handle({ action: 'apply_update', options: { update: { file: '../../etc/passwd', sha256: 'a'.repeat(64) } } }), /请求无效/);
    await assert.rejects(t.updater.handle({ action: 'format_disk' }), /不支持/);
    assert.equal(await readFile(path.join(t.project, 'server.mjs'), 'utf8'), 'OLD');
    assert.equal(t.calls.filter(c => /compose up/.test(c)).length, 0, '被拒绝时一次 docker 重建都没有发生');
    assert.equal((await t.updater.handle({ action: 'update_status' })).details.state, 'idle');
  } finally { await rm(t.base, { recursive: true, force: true }); }
});

test('Docker 更新器的接口：没有令牌 / 令牌错误一律 403，正确令牌可查询状态', async () => {
  const t = await setup(() => true), token = 'u'.repeat(40), server = await startServer({ token, updater: t.updater, port: 0, host: '127.0.0.1' }), port = server.address().port;
  try {
    const call = (auth, body) => new Promise((resolve, reject) => { const req = http.request({ port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) } }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => resolve({ status: res.statusCode, body: raw })); }); req.on('error', reject); req.end(JSON.stringify(body)); });
    assert.equal((await call('', { action: 'update_status' })).status, 403);
    assert.equal((await call('Bearer ' + 'x'.repeat(40), { action: 'update_status' })).status, 403);
    const ok = await call('Bearer ' + token, { action: 'update_status' }); assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).details.state, 'idle');
  } finally { server.close(); await rm(t.base, { recursive: true, force: true }); }
});
