import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };

test('桌面端浏览器桌面：仅管理员可访问 HTTP 与 WebSocket 反向代理；未配置时关闭', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-desktop-'));
  const keyFile = path.join(dir, 'k'); await writeFile(keyFile, randomBytes(32).toString('base64'));
  const seen = { cookie: '' };
  const upstream = http.createServer((req, res) => { seen.cookie = req.headers.cookie || ''; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('novnc:' + req.url); });
  upstream.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); socket.on('data', d => socket.write('echo:' + d)); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const run = async extraEnv => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: await mkdtemp(path.join(dir, 'd-')), COOKIE_SECURE: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ...extraEnv }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => { child.on('exit', c => reject(new Error('exit ' + c))); child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
    return { child, port, base: 'http://127.0.0.1:' + port };
  };
  const login = async (base, body) => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) }); return (r.headers.get('set-cookie') || '').split(';')[0]; };
  const wsProbe = (port, cookie) => new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET /desktop/websockify HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n${cookie ? 'Cookie: ' + cookie + '\r\n' : ''}\r\n`));
    let buf = ''; s.on('data', d => { buf += d; if (buf.includes('101')) s.write('ping'); if (buf.includes('echo:ping') || buf.includes('403')) { s.destroy(); resolve(buf); } }); s.on('close', () => resolve(buf));
    setTimeout(() => { s.destroy(); resolve(buf); }, 3000);
  });
  const on = await run({ DESKTOP_VIEW_URL: `http://127.0.0.1:${upstream.address().port}` });
  const off = await run({});
  try {
    const adminCookie = await login(on.base, ADMIN);
    // 匿名被拒
    assert.equal((await fetch(on.base + '/desktop/vnc.html')).status, 403);
    assert.match(await wsProbe(on.port, ''), /403/);
    // 管理员：HTTP 转发，且不会把我们的会话 cookie 泄露给桌面容器
    const page = await fetch(on.base + '/desktop/vnc.html?autoconnect=1', { headers: { Cookie: adminCookie } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), 'novnc:/vnc.html?autoconnect=1');
    assert.equal(seen.cookie, '');
    // 管理员：WebSocket 升级并双向转发
    assert.match(await wsProbe(on.port, adminCookie), /101[\s\S]*echo:ping/);
    // 状态接口
    const info = await (await fetch(on.base + '/api/admin/desktop', { headers: { Cookie: adminCookie } })).json();
    assert.equal(info.enabled, true); assert.match(info.url, /^\/desktop\/vnc\.html/);
    // 成员不能用
    const csrf = (await (await fetch(on.base + '/api/auth/session', { headers: { Cookie: adminCookie } })).json()).csrfToken;
    const add = await fetch(on.base + '/api/admin/members', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: on.base, Cookie: adminCookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ email: 'm@example.com', password: 'member-password-123' }) });
    assert.equal(add.status, 201);
    const memberCookie = await login(on.base, { email: 'm@example.com', password: 'member-password-123' });
    assert.equal((await fetch(on.base + '/desktop/vnc.html', { headers: { Cookie: memberCookie } })).status, 403);
    assert.match(await wsProbe(on.port, memberCookie), /403/);
    assert.equal((await fetch(on.base + '/api/admin/desktop', { headers: { Cookie: memberCookie } })).status, 403);
    // 跨站来源被拒
    assert.equal((await fetch(on.base + '/desktop/vnc.html', { headers: { Cookie: adminCookie, Origin: 'https://evil.example' } })).status, 403);
    // 未配置：功能关闭
    const offCookie = await login(off.base, ADMIN);
    assert.equal((await fetch(off.base + '/desktop/vnc.html', { headers: { Cookie: offCookie } })).status, 404);
    assert.equal((await (await fetch(off.base + '/api/admin/desktop', { headers: { Cookie: offCookie } })).json()).enabled, false);
  } finally {
    on.child.removeAllListeners('exit'); off.child.removeAllListeners('exit'); on.child.kill(); off.child.kill(); upstream.close();
    await new Promise(r => setTimeout(r, 200)); await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
