import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { createZip } from '../ziputil.mjs';
import { signRelease } from '../updatepkg.mjs';
import { createDemoUpdater } from '../demo.mjs';

const KEY = generateKeyPairSync('ed25519');
const pem = (k, kind) => k[kind].export({ type: kind === 'privateKey' ? 'pkcs8' : 'spki', format: 'pem' });
const pkg = version => JSON.stringify({ name: 'yumeiro-web', version, dependencies: { a: '1' } });
const release = (version, { demo = true } = {}) => {
  const names = ['server.mjs', 'public/index.html', 'deploy/yumeiro-native.sh', ...(demo ? ['demo.mjs'] : [])];
  const list = names.map(n => ({ name: 'Yumeiro/' + n, data: 'v' + version + ':' + n })).concat({ name: 'Yumeiro/package.json', data: pkg(version) });
  return createZip([...list, ...signRelease(list, version, pem(KEY, 'privateKey'))]);
};
let pubDir;
test.before(async () => { pubDir = await mkdtemp(path.join(tmpdir(), 'ymd-pub-')); await writeFile(path.join(pubDir, 'p.pem'), pem(KEY, 'publicKey')); process.env.YUMEIRO_RELEASE_PUBKEY_FILE = path.join(pubDir, 'p.pem'); });

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), 'ymd-')), root = path.join(base, 'app'), data = path.join(base, 'data'), appDir = path.join(base, 'running');
  await mkdir(path.join(root, 'node_modules'), { recursive: true }); await mkdir(path.join(data, 'updates'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), pkg('0.46.3'));
  let exited = 0;
  const updater = createDemoUpdater({ root, modulesDir: path.join(root, 'node_modules'), appDir, dataDir: data, version: '0.46.3', exit: () => { exited++; } });
  const put = async bytes => { const file = 'incoming-' + randomUUID() + '.zip'; await writeFile(path.join(data, 'updates', file), bytes); return { file, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const done = async () => { for (let i = 0; i < 100; i++) { const st = (await updater.handle({ action: 'update_status' })).details; if (st.state === 'ok' || st.state === 'failed') return st; await new Promise(r => setTimeout(r, 30)); } throw new Error('timeout'); };
  return { appDir, updater, put, done, exited: () => exited };
}
const exists = p => stat(p).then(() => true, () => false);

test('演示站：降级只是模拟，不换代码、不重启、版本不变', async () => {
  const t = await setup();
  for (const version of ['0.46.1', '0.46.3']) {
    const u = await t.put(release(version));
    const result = await t.updater.handle({ action: 'apply_update', options: { update: { ...u, allowDowngrade: true } } });
    assert.equal(result.details.simulated, true);
    const st = (await t.updater.handle({ action: 'update_status' })).details;
    assert.equal(st.state, 'ok'); assert.equal(st.version, '0.46.3'); assert.match(st.log, /模拟/);
  }
  assert.equal(t.exited(), 0); assert.equal(await exists(t.appDir), false);
});

test('演示站：更新的版本会真的安装，并带上 node_modules 后重启', async () => {
  const t = await setup();
  const u = await t.put(release('0.46.4'));
  const result = await t.updater.handle({ action: 'apply_update', options: { update: u } });
  assert.equal(result.details.version, '0.46.4');
  const st = await t.done();
  assert.equal(st.state, 'ok'); assert.equal(st.version, '0.46.4');
  assert.equal(JSON.parse(await readFile(path.join(t.appDir, 'package.json'), 'utf8')).version, '0.46.4');
  assert.equal(await exists(path.join(t.appDir, 'node_modules')), true);
  assert.equal(await exists(path.join(t.appDir, 'demo.mjs')), true);
  assert.equal(t.exited(), 1);
});

test('演示站：新版本不含演示模式就不安装，保持当前版本', async () => {
  const t = await setup();
  const u = await t.put(release('0.46.4', { demo: false }));
  await t.updater.handle({ action: 'apply_update', options: { update: u } });
  const st = await t.done();
  assert.equal(st.state, 'failed'); assert.match(st.log, /demo\.mjs/);
  assert.equal(await exists(t.appDir), false); assert.equal(t.exited(), 0);
});

test('演示站：含客户端的包和被改动的文件会被拒绝', async () => {
  const t = await setup();
  const u = await t.put(release('0.46.4'));
  await assert.rejects(t.updater.handle({ action: 'apply_update', options: { update: { ...u, sha256: 'a'.repeat(64) } } }), /改动/);
});
