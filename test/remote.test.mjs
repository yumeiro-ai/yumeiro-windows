import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newPairCode, normalizePairCode, cleanInputEvents, countEvents, isJpeg, agentCommands, cleanDeviceName } from '../remote.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('配对码：格式、规范化、不含易混字符', () => {
  for (let i = 0; i < 200; i++) assert.match(newPairCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizePairCode('abcd efgh'), 'ABCD-EFGH'); assert.equal(normalizePairCode('abcd-efg'), ''); assert.equal(normalizePairCode(null), '');
  assert.equal(cleanDeviceName('  <b>办公室</b>\n电脑 '.repeat(5)).length <= 40, true);
  const cmds = agentCommands('https://x.example', 'ABCD-EFGH', { control: false });
  assert.match(cmds.windows, /--view-only/); assert.match(cmds.mac, /curl .*\/remote\/agent\.mjs/); assert.match(agentCommands('https://x', 'A', {}).mac, /--allow-control/);
});

test('输入事件校验：坐标夹取、按键白名单、文字长度与控制字符、批量上限', () => {
  const ok = cleanInputEvents([{ type: 'move', x: 2, y: -1 }, { type: 'click', x: 0.5, y: 0.5, button: 'right', count: 2 }, { type: 'down', button: 'x' }, { type: 'wheel', dy: 999, dx: -3.7 }, { type: 'key', key: 'C', mods: ['ctrl', 'evil', 'shift'] }, { type: 'key', key: 'Enter' }, { type: 'key', key: 'F5', action: 'down' }, { type: 'text', text: '你好 hello\n第二行' }]);
  assert.deepEqual(ok[0], { type: 'move', x: 1, y: 0 }); assert.deepEqual(ok[1], { type: 'click', button: 'right', x: 0.5, y: 0.5, count: 2 }); assert.deepEqual(ok[2], { type: 'down', button: 'left' });
  assert.deepEqual(ok[3], { type: 'wheel', dx: -3, dy: 20 }); assert.deepEqual(ok[4], { type: 'key', key: 'C', action: 'press', mods: ['ctrl', 'shift'] });
  assert.deepEqual(ok[5], { type: 'key', key: 'enter', action: 'press', mods: [] }); assert.equal(ok[6].key, 'f5'); assert.equal(ok[6].action, 'down'); assert.equal(ok[7].text, '你好 hello\n第二行');
  for (const bad of [[], 'x', [{ type: 'rm -rf' }], [{ type: 'move', x: 'a', y: 0 }], [{ type: 'click', x: 0.1 }], [{ type: 'key', key: 'Delete\u0000' }], [{ type: 'key', key: 'longname' }], [{ type: 'text', text: '' }], [{ type: 'text', text: 'a\u0007b' }], [{ type: 'text', text: 'x'.repeat(201) }], Array(41).fill({ type: 'move', x: 0, y: 0 })]) assert.throws(() => cleanInputEvents(bad), /./, JSON.stringify(bad).slice(0, 60));
  assert.deepEqual(countEvents(ok), { events: 8, keys: 3, textChars: 12, clicks: 2 });
  assert.equal(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), true); assert.equal(isJpeg(Buffer.from('GIF89a....')), false);
});

// ---------- 整站 + 真实被控端程序（假后端，不碰桌面）----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, app, base, owner;
const agents = [];
async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
}
const call = async (auth, p, method = 'GET', body, extra = {}) => {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json().catch(() => ({})) : Buffer.from(await response.arrayBuffer()) };
};
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };
async function startAgent(name, flag) {
  const pair = (await call(owner, '/api/remote/pair', 'POST', { name, control: flag !== '--view-only' })).data;
  const config = path.join(dir, name + '.json');
  const child = spawn(process.execPath, ['public/agent.mjs', '--server', base, '--code', pair.code.toLowerCase().replace('-', ' '), flag, '--backend', 'fake', '--config', config], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle = { child, config, out: '', exited: null };
  child.stdout.on('data', c => { handle.out += c; }); child.stderr.on('data', c => { handle.out += c; });
  child.on('exit', code => { handle.exited = code; });
  agents.push(handle);
  assert.ok(await until(() => /配对成功/.test(handle.out)), '配对输出：' + handle.out);
  const device = await until(async () => (await call(owner, '/api/remote/devices')).data.devices.find(d => d.name === name && d.online));
  assert.ok(device, '设备应上线');
  return Object.assign(handle, { device, code: pair.code });
}
const fakeOps = agent => [...agent.out.matchAll(/^FAKE (.*)$/gm)].map(m => JSON.parse(m[1]));

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ym-remote-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_NAME: 'm', MODEL_API_KEY: 'k', ENV_CHECK_INTERVAL_MS: '0' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
});
test.after(async () => { for (const a of agents) a.child.kill(); app?.removeAllListeners('exit'); app?.kill(); await new Promise(r => setTimeout(r, 400)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

test('配对 → 在线 → 看画面 → 点击/打字 → 关闭控制 → 删除设备', async () => {
  assert.equal((await fetch(base + '/api/remote/devices')).status, 401);
  assert.equal((await fetch(base + '/remote/agent/poll')).status, 401, '没有令牌不能连');
  assert.equal((await fetch(base + '/remote/agent/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'ZZZZ-ZZZZ' }) })).status, 400, '配对码错误');
  const agent = await startAgent('办公室台式机', '--allow-control');
  assert.equal(agent.device.allowControl, true);
  const saved = JSON.parse(await readFile(agent.config, 'utf8')); assert.match(saved.token, /^rda_/); assert.equal(saved.control, true);
  assert.equal((await fetch(base + '/remote/agent/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: agent.code }) })).status, 400, '配对码只能用一次');

  const frame = await call(owner, `/api/remote/devices/${agent.device.id}/frame?since=0`);
  assert.equal(frame.status, 200); assert.equal(frame.headers.get('content-type'), 'image/jpeg'); assert.equal(isJpeg(frame.data), true); assert.equal(frame.headers.get('x-control'), '1'); assert.equal(frame.headers.get('x-screen-width'), '1920');

  const sent = await call(owner, `/api/remote/devices/${agent.device.id}/input`, 'POST', { events: [{ type: 'click', x: 0.5, y: 0.25, button: 'left' }, { type: 'key', key: 'c', mods: ['ctrl'] }, { type: 'text', text: '秘密密码123' }, { type: 'wheel', dy: 3 }] });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.ok(await until(() => fakeOps(agent).some(op => op[0] === 'wheel')), '被控端应收到操作：' + agent.out);
  const ops = fakeOps(agent).map(op => op[0] + (op[0] === 'button' ? ':' + op[2] : op[0] === 'key' ? ':' + op[1] + ':' + op[2] : ''));
  assert.deepEqual(ops, ['move', 'button:down', 'button:up', 'key:ctrl:down', 'key:c:down', 'key:c:up', 'key:ctrl:up', 'text', 'wheel']);
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}/input`, 'POST', { events: [{ type: 'format-disk' }] })).status, 400);
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}/input`, 'POST', { events: [{ type: 'text', text: 'a\u0007' }] })).status, 400);

  // 关闭“允许控制”：立即变成仅查看
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}`, 'PATCH', { allowControl: false })).data.device.allowControl, false);
  const denied = await call(owner, `/api/remote/devices/${agent.device.id}/input`, 'POST', { events: [{ type: 'move', x: 0, y: 0 }] }); assert.equal(denied.status, 403); assert.match(denied.data.error, /仅查看/);
  await call(owner, `/api/remote/devices/${agent.device.id}`, 'PATCH', { allowControl: true, name: '办公室电脑' });
  assert.equal((await call(owner, '/api/remote/devices')).data.devices[0].name, '办公室电脑');

  // 审计里有记录，但不含输入的文字内容
  const csv = await call(owner, '/api/admin/audit.csv'); assert.equal(csv.status, 200);
  const text = csv.data.toString('utf8'); assert.match(text, /remote\.pair/); assert.match(text, /remote\.view/); assert.match(text, /remote\.control/); assert.ok(!text.includes('秘密密码123'), '审计不能记录输入的文字');

  // 停止查看后不再要画面；删除设备后被控端自动退出
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}/stop`, 'POST', {})).status, 200);
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}`, 'DELETE')).status, 200);
  assert.ok(await until(() => agent.exited !== null, 20000), '被取消配对后被控端应退出');
  assert.match(agent.out, /取消配对/);
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}/frame?since=0`)).status, 404);
});

test('仅查看的被控端：即使网页允许控制，也不会执行任何操作；伪造帧被拒绝', async () => {
  const agent = await startAgent('只读电脑', '--view-only');
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}/frame?since=0`)).status, 200);
  const r = await call(owner, `/api/remote/devices/${agent.device.id}/input`, 'POST', { events: [{ type: 'move', x: 0.1, y: 0.1 }] });
  assert.equal(r.status, 403); assert.match(r.data.error, /仅查看/);
  await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(fakeOps(agent).length, 0, '没有任何输入被执行');
  const token = JSON.parse(await readFile(agent.config, 'utf8')).token;
  const bad = await fetch(base + '/remote/agent/frame', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'image/jpeg' }, body: Buffer.from('<script>alert(1)</script>') });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(base + '/remote/agent/poll', { headers: { Authorization: 'Bearer rda_' + 'x'.repeat(43) } })).status, 401);
  const page = await fetch(base + '/remote'); assert.equal(page.status, 200); assert.match(await page.text(), /remote\.js/);
  const agentFile = await fetch(base + '/remote/agent.mjs'); assert.equal(agentFile.status, 200); assert.match(await agentFile.text(), /Yumeiro 远程控制/);
  for (const p of ['/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/icon.svg', '/offline.html', '/pwa.js']) assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal(JSON.parse(await (await fetch(base + '/manifest.webmanifest')).text()).display, 'standalone');
  await call(owner, `/api/remote/devices/${agent.device.id}`, 'DELETE');
});

// ---- 画面清晰度 / 流畅度自动升降档 ----
import { REMOTE_LEVELS, newAdaptive, sampleAdaptive, remoteProfile, setRemoteMode, normalizeRemoteMode } from '../remote.mjs';

test('自动画质：下载太慢就逐档降，有冷却，降到最低为止', () => {
  const a = newAdaptive(0); assert.equal(remoteProfile(a).level, 2);
  assert.equal(sampleAdaptive(a, { dlMs: 1500 }, 1000), false, '刚开始 3 秒内不动');
  assert.equal(sampleAdaptive(a, { dlMs: 1500 }, 4000), true); assert.equal(remoteProfile(a).level, 3);
  assert.equal(sampleAdaptive(a, { dlMs: 1500 }, 5000), false, '刚降过要冷却 3 秒');
  let now = 5000; for (let i = 0; i < 30; i++) { now += 3500; sampleAdaptive(a, { dlMs: 3000 }, now); }
  assert.equal(remoteProfile(a).level, REMOTE_LEVELS.length - 1, '最多降到最低档');
  assert.ok(remoteProfile(a).maxWidth <= 800 && remoteProfile(a).quality < 62);
});
test('自动画质：电脑端上传慢、观看端落后好几帧，也会降档', () => {
  const up = newAdaptive(0); assert.equal(sampleAdaptive(up, { upMs: 2000 }, 4000), true);
  const lag = newAdaptive(0); for (let t = 1; t <= 4; t++) sampleAdaptive(lag, { skipped: 4 }, t * 1000); assert.ok(remoteProfile(lag).level > 2);
});
test('自动画质：稳定一阵才慢慢升回来，抖一下不会乱升', () => {
  const a = newAdaptive(0); a.level = 4; a.changedAt = 0;
  assert.equal(sampleAdaptive(a, { dlMs: 40, upMs: 40 }, 5000), false, '没稳定够 12 秒不升');
  assert.equal(sampleAdaptive(a, { dlMs: 800 }, 6000), false); // 抖一下：重新计时，且不会连降（EMA 还没超线）
  let now = 6000, changed = 0; for (let i = 0; i < 40; i++) { now += 1000; if (sampleAdaptive(a, { dlMs: 40, upMs: 40 }, now)) changed++; }
  assert.ok(changed >= 1 && remoteProfile(a).level < 4, '稳定以后升了档');
});
test('手动模式固定档位，不再自动变；切模式清掉旧测量', () => {
  const a = newAdaptive(0);
  assert.equal(remoteProfile(setRemoteMode(a, 'high', 0)).level, 1); assert.equal(sampleAdaptive(a, { dlMs: 5000 }, 99999), false); assert.equal(remoteProfile(a).level, 1);
  assert.equal(remoteProfile(setRemoteMode(a, 'smooth', 0)).level, 4);
  assert.equal(remoteProfile(setRemoteMode(a, 'bogus', 0)).mode, 'auto'); assert.equal(normalizeRemoteMode('constructor'), 'auto');
});

test('整站：观看端报告下载很慢 → 自动降档（响应头里能看到）；手动选“流畅优先/清晰优先”后固定；接口权限', async () => {
  const agent = await startAgent('画质测试', '--allow-control');
  const url = since => `/api/remote/devices/${agent.device.id}/frame?since=${since}`;
  const first = await until(async () => { const r = await call(owner, url(0)); return r.status === 200 ? r : null; }); assert.ok(first, '应该拿到第一帧');
  assert.equal(first.headers.get('x-mode'), 'auto'); const startWidth = Number(first.headers.get('x-profile').split('|')[0]); assert.equal(startWidth, 1280);
  // 手动固定
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}/quality`, 'POST', { mode: 'smooth' })).data.mode, 'smooth');
  let r = await call(owner, url(0)); assert.equal(r.headers.get('x-profile').split('|')[0], '800'); assert.equal(r.headers.get('x-mode'), 'smooth');
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}/quality`, 'POST', { mode: 'high' })).data.profile.maxWidth, 1600);
  assert.equal((await call(owner, `/api/remote/devices/${agent.device.id}/quality`, 'POST', { mode: '乱写' })).data.mode, 'auto', '不认识的模式回到自动');
  // 自动：连续报告很慢，隔 3 秒以上再报一次，就会降档
  await call(owner, url(0) + '&dl=4000'); await new Promise(r => setTimeout(r, 3300));
  r = await call(owner, url(0) + '&dl=4000'); await new Promise(r => setTimeout(r, 200));
  r = await call(owner, url(0) + '&dl=4000');
  const width = Number(r.headers.get('x-profile').split('|')[0]); assert.ok(width < startWidth, '慢了应该降档，当前宽度 ' + width);
  // 别人的设备不能改画质
  const other = await call(owner, '/api/remote/devices/00000000-0000-0000-0000-000000000000/quality', 'POST', { mode: 'high' }); assert.equal(other.status, 404);
});

test('Windows 客户端自带的被控端程序和 public/agent.mjs 保持一致（改了 agent.mjs 要运行 node scripts/sync-clients.mjs）', async () => {
  const [a, b] = await Promise.all([readFile(path.join(root, 'public', 'agent.mjs'), 'utf8'), readFile(path.join(root, 'clients', 'windows', 'agent', 'agent.mjs'), 'utf8')]);
  assert.equal(b, a);
  const pkg = JSON.parse(await readFile(path.join(root, 'clients', 'windows', 'package.json'), 'utf8')); // 打包清单里要有被控端和管理它的模块，否则装好的客户端里没有
  assert.ok(pkg.build.files.includes('remote-agent.js') && pkg.build.files.includes('agent/**'));
});
