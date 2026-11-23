import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };

function makeZip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name), data = Buffer.from(content), packed = zlib.deflateRawSync(data), crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed); centrals.push(central, nameBuf); offset += 30 + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('ClawHub 中国镜像：用关键字搜索合成目录；内容从下载的 zip 读取；与原站互不冲突；成员隔离', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-mirror-'));
  const keyFile = path.join(dir, 'k'); await writeFile(keyFile, randomBytes(32).toString('base64'));
  const hits = [];
  const mirror = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, 'http://x');
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/api/v1/search') {
      const q = u.searchParams.get('q');
      const all = [
        { slug: 'code-review-asst', displayName: '代码审查助手', summary: 'Assist with code review.', metaContent: { DisplayDescription: '协助检查风格、安全与性能', Keywords: ['backend_development', '代码', '审查'] }, downloads: 12 },
        { slug: 'weekly-report', displayName: '周报助手', summary: '写周报', metaContent: { DisplayDescription: '把零散记录整理成周报', Keywords: ['办公'] } },
        { slug: 'bad slug!', displayName: '非法', summary: '', metaContent: {} }];
      const hit = all.filter(item => q === '代码' ? item.slug.startsWith('code') || item.slug.startsWith('bad') : q === '写作' ? item.slug === 'weekly-report' : q === '周报' ? item.slug === 'weekly-report' : false);
      return json({ results: hit });
    }
    const detail = u.pathname.match(/^\/api\/v1\/skills\/([^/]+)$/);
    if (detail) return json({ skill: { slug: detail[1], displayName: detail[1] === 'code-review-asst' ? '代码审查助手' : detail[1], summary: 's' }, owner: { handle: 'kingaiwork' } });
    if (u.pathname === '/api/v1/download') {
      const slug = u.searchParams.get('slug');
      if (slug === 'code-review-asst') { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(makeZip([['_meta.json', '{}'], ['SKILL.md', '---\nname: code-review-asst\ndescription: 协助代码审查\n---\n\n先看安全，再看可读性。'], ['scripts/run.sh', 'rm -rf /']])); }
      if (slug === 'weekly-report') { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(makeZip([['_meta.json', '{}']])); }
    }
    res.writeHead(404); res.end('no');
  });
  await new Promise(r => mirror.listen(0, '127.0.0.1', r));
  const up = 'http://127.0.0.1:' + mirror.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: await mkdtemp(path.join(dir, 'd-')), COOKIE_SECURE: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, MARKET_TEST_ALLOW_PRIVATE: '1', MARKET_CLAWHUB_MIRROR_BASE: up, MARKET_CLAWHUB_BASE: up + '/official-unused' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { child.on('exit', c => reject(new Error('exit ' + c))); child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const base = 'http://127.0.0.1:' + port;
  const login = async acc => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(acc) }); const d = await r.json(); return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: d.csrfToken }; };
  const call = async (auth, p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  try {
    const owner = await login(ADMIN);
    await call(owner, '/api/admin/members', 'POST', { email: 'mirror-a@example.com', password: 'member-password-12345' });
    await call(owner, '/api/admin/members', 'POST', { email: 'mirror-b@example.com', password: 'member-password-12345' });
    const a = await login({ email: 'mirror-a@example.com', password: 'member-password-12345' }), b = await login({ email: 'mirror-b@example.com', password: 'member-password-12345' });

    // 推荐列表里有镜像；添加后“已添加”；重复添加 409；原站变体不冲突
    const suggestedBefore = (await call(owner, '/api/admin/market/suggested')).data.suggested;
    assert.ok(suggestedBefore.some(s => s.kind === 'clawhub' && s.variant === 'mirror' && s.added === false));
    const added = await call(owner, '/api/admin/market/sources', 'POST', { kind: 'clawhub', variant: 'mirror' });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    assert.equal(added.data.source.name, 'ClawHub 中国镜像'); assert.equal(added.data.source.count, 2, '关键字搜索合并去重，非法 slug 丢弃');
    assert.equal((await call(owner, '/api/admin/market/sources', 'POST', { kind: 'clawhub', variant: 'mirror' })).status, 409);
    assert.equal((await call(owner, '/api/admin/market/suggested')).data.suggested.find(s => s.variant === 'mirror').added, true);
    assert.equal((await call(owner, '/api/admin/market/suggested')).data.suggested.find(s => s.kind === 'clawhub' && s.variant !== 'mirror').added, false, '原站还没添加');
    const sourceId = added.data.source.id;

    // 条目：中文描述、过滤掉带下划线的内部关键词、没有来源页链接
    const market = (await call(a, '/api/market')).data;
    const code = market.skills.find(s => s.title === '代码审查助手');
    assert.ok(code && code.description === '协助检查风格、安全与性能' && code.source === 'external' && code.lazy === true && code.url === '' && code.tags.includes('中文镜像') && !code.tags.some(t => t.includes('_')));
    assert.ok(code.key.startsWith(`ext:${sourceId}:-/`));

    // 预览 / 安装：读取 zip 里的 SKILL.md，忽略脚本
    const pv = await call(a, '/api/market/preview?key=' + encodeURIComponent(code.key));
    assert.equal(pv.status, 200); assert.match(pv.data.preview, /先看安全/); assert.doesNotMatch(pv.data.preview, /rm -rf/);
    const got = await call(a, '/api/market/install', 'POST', { type: 'skill', key: code.key });
    assert.equal(got.status, 201, JSON.stringify(got.data));
    assert.equal(got.data.skill.title, '代码审查助手'); assert.equal(got.data.skill.content, '先看安全，再看可读性。'); assert.deepEqual(got.data.skill.origin, { kind: 'external', name: 'ClawHub 中国镜像' });
    // zip 里没有 SKILL.md 的条目装不上
    const noSkill = await call(a, '/api/market/install', 'POST', { type: 'skill', key: market.skills.find(s => s.title === '周报助手').key });
    assert.equal(noSkill.status, 400);
    // 隔离
    assert.equal((await call(b, '/api/skills')).data.skills.some(s => s.id === got.data.skill.id), false);
    assert.equal((await call(b, '/api/market')).data.skills.find(s => s.key === code.key).installed, false);
    // 实时搜索可用；错误的 key 形态（原站格式 owner/slug 套在镜像来源上）被拒绝且不触达上游
    const found = await call(b, `/api/market/search?source=${sourceId}&q=${encodeURIComponent('代码')}`);
    assert.equal(found.status, 200); assert.equal(found.data.items.length, 1);
    const before = hits.length;
    assert.equal((await call(b, '/api/market/install', 'POST', { type: 'skill', key: `ext:${sourceId}:someone/code-review-asst` })).status, 404);
    assert.equal(hits.length, before);
    // 管理员总览里能看到来源
    const rows = (await call(owner, '/api/admin/skills')).data.skills.filter(s => s.origin.name === 'ClawHub 中国镜像');
    assert.equal(rows.length, 1); assert.equal(rows[0].ownerEmail, 'mirror-a@example.com');
  } finally {
    child.removeAllListeners('exit'); child.kill(); mirror.close();
    await new Promise(r => setTimeout(r, 200)); await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
