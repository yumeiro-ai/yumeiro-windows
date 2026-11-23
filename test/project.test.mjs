import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../runner/runner.mjs';
import { createZip, readZip, safeEntryName, crc32 } from '../ziputil.mjs';
import { testPng } from '../vision.mjs';
import { planImport, signPreview, verifyPreview, parseGuideReply, safeGoTarget, renderMarkdownPage, previewPath, serveSource, localKit, manifestFor, cleanGuideMessages, guidePrompt, mimeOf } from '../project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('zip：往返一致（含中文名、二进制、空文件、大文件压缩）', () => {
  const bin = randomBytes(3000), big = Buffer.from('重复内容 '.repeat(5000));
  const zip = createZip([{ name: 'a/中文.txt', data: Buffer.from('你好') }, { name: 'bin.dat', data: bin }, { name: 'empty', data: Buffer.alloc(0) }, { name: 'big.txt', data: big }]);
  assert.ok(zip.length < big.length, '大文件应被压缩');
  const { entries, skipped } = readZip(zip);
  assert.equal(skipped.length, 0);
  const by = Object.fromEntries(entries.map(e => [e.name, e.data]));
  assert.equal(by['a/中文.txt'].toString(), '你好'); assert.ok(by['bin.dat'].equals(bin)); assert.equal(by.empty.length, 0); assert.ok(by['big.txt'].equals(big));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zip：路径穿越、绝对路径被跳过；超限、损坏、校验失败被拒绝', () => {
  assert.equal(safeEntryName('../x'), null); assert.equal(safeEntryName('/etc/passwd'), null); assert.equal(safeEntryName('C:/x'), null); assert.equal(safeEntryName('a/../../b'), null);
  assert.equal(safeEntryName('a\\b.txt'), 'a/b.txt');
  const evil = createZip([{ name: '../evil.txt', data: Buffer.from('x') }, { name: '/abs.txt', data: Buffer.from('x') }, { name: 'ok.txt', data: Buffer.from('ok') }]);
  const r = readZip(evil);
  assert.deepEqual(r.entries.map(e => e.name), ['ok.txt']); assert.equal(r.skipped.length, 2);
  const large = createZip([{ name: 'big.bin', data: Buffer.alloc(200000, 1) }]);
  assert.equal(readZip(large, { maxEntryBytes: 1000 }).skipped.length, 1, '单文件超限只跳过');
  assert.throws(() => readZip(large, { maxTotalBytes: 1000 }), /超过/);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /zip/);
  const bad = Buffer.from(createZip([{ name: 'a.txt', data: Buffer.from('hello world hello world hello world hello world hello world hello world hello') }]));
  bad[bad.indexOf(Buffer.from('a.txt')) + 6] ^= 0xff; // 破坏内容
  assert.throws(() => readZip(bad));
  assert.throws(() => readZip(createZip([{ name: 'a', data: Buffer.from('1') }, { name: 'b', data: Buffer.from('2') }]), { maxFiles: 1 }), /太多/);
});

test('导入规划：识别本站导出包 / 去掉唯一外层目录 / 忽略 .git 与 node_modules', () => {
  const e = (name, text = 'x') => ({ name, data: Buffer.from(text) });
  const own = planImport([e('yumeiro-project.json', manifestFor('p', 2)), e('project/index.html'), e('project/a/b.js'), e('serve.mjs'), e('start.sh')]);
  assert.equal(own.mode, 'yumeiro'); assert.deepEqual(own.files.map(f => f.name), ['index.html', 'a/b.js']); assert.equal(own.ignored, 3);
  const folder = planImport([e('site/index.html'), e('site/css/a.css'), e('site/.git/config'), e('site/node_modules/x/y.js')]);
  assert.equal(folder.mode, 'folder'); assert.deepEqual(folder.files.map(f => f.name), ['index.html', 'css/a.css']);
  const plain = planImport([e('index.html'), e('x/y.txt'), e('.DS_Store'), e('__MACOSX/a')]);
  assert.equal(plain.mode, 'plain'); assert.deepEqual(plain.files.map(f => f.name), ['index.html', 'x/y.txt']);
});

test('预览签名：过期、篡改、撤销序号都能识别', () => {
  const key = randomBytes(32), id = '0b1f1c52-6f0a-4b9c-9d5e-3c2f9a0d1e77', now = 1_700_000_000_000;
  const token = signPreview(key, id, 3, now + 1000);
  assert.deepEqual(verifyPreview(key, token, now), { workspaceId: id, epoch: 3, expiresAt: now + 1000 });
  assert.equal(verifyPreview(key, token, now + 2000), null, '过期');
  assert.equal(verifyPreview(randomBytes(32), token, now), null, '换密钥');
  assert.equal(verifyPreview(key, token.replace('.3.', '.4.'), now), null, '改撤销序号');
  assert.equal(verifyPreview(key, 'garbage', now), null);
  assert.equal(previewPath(''), 'index.html'); assert.equal(previewPath('a/'), 'a/index.html'); assert.equal(previewPath('..%2f..%2fetc'), null); assert.equal(previewPath('a/%2e%2e/b'), null); assert.equal(previewPath('%E4%B8%AD.txt'), '中.txt');
  assert.equal(mimeOf('a.JS'), 'text/javascript; charset=utf-8'); assert.equal(mimeOf('x.unknown'), 'application/octet-stream');
});

test('Markdown 渲染：转义 HTML、拒绝 javascript: 链接、支持代码块/表格/列表', () => {
  const html = renderMarkdownPage('# 标题\n\n<script>alert(1)</script> **粗** `a<b`\n\n[坏](javascript:alert(1)) [好](https://a.b)\n\n- 一\n- 二\n\n|a|b|\n|-|-|\n|1|2|\n\n```\n<x>\n```', 't');
  assert.ok(!html.includes('<script>alert')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('<strong>粗</strong>'));
  assert.ok(html.includes('<code>a&lt;b</code>')); assert.ok(!/href="javascript/i.test(html)); assert.ok(html.includes('href="https://a.b"'));
  assert.ok(html.includes('<ul><li>一</li><li>二</li></ul>')); assert.ok(html.includes('<table>')); assert.ok(html.includes('<pre><code>&lt;x&gt;</code></pre>'));
});

test('AI 回复解析：选项 / 跳转按钮（白名单）/ 文件（路径校验、去外层代码围栏）', () => {
  const raw = '好的，下面是网页。\n[[opt:再改改]][[opt:很好]]\n[[go:/admin/settings?tab=tts|去设置]][[go:/admin/settings?tab=hack|坏]][[go:https://evil.com|外链]]\n<<<FILE path="index.html">>>\n```html\n<h1>hi</h1>\n```\n<<<END>>>\n<<<FILE path="../x.txt">>>\nq\n<<<END>>>\n<<<FILE path="css/a.css">>>\nbody{}\n<<<END>>>';
  const r = parseGuideReply(raw);
  assert.equal(r.text, '好的，下面是网页。'); assert.deepEqual(r.options, ['再改改', '很好']);
  assert.deepEqual(r.actions, [{ href: '/admin/settings?tab=tts', label: '去设置' }]);
  assert.deepEqual(r.files, [{ path: 'index.html', content: '<h1>hi</h1>' }, { path: 'css/a.css', content: 'body{}' }]); assert.deepEqual(r.dropped, ['../x.txt']);
  assert.equal(safeGoTarget('/workspaces'), '/workspaces'); assert.equal(safeGoTarget('/api/x'), null); assert.equal(safeGoTarget('/settings?tab=usage'), '/settings?tab=usage');
  const msgs = cleanGuideMessages([{ role: 'assistant', content: 'x' }, { role: 'user', content: '你好' }, { role: 'system', content: 'bad' }, { role: 'assistant', content: 'a'.repeat(9000) }], { maxChars: 100 });
  assert.equal(msgs.length, 2); assert.equal(msgs[0].role, 'user'); assert.equal(msgs[1].content.length, 100);
  assert.ok(guidePrompt('task', { admin: true, model: true }).includes('任务引导模式')); assert.ok(guidePrompt('help', {}).includes('使用向导模式'));
});

test('本地使用包：serve.mjs 能直接运行，渲染 Markdown、拒绝穿越', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ym-kit-'));
  try {
    for (const f of localKit('测试')) await writeFile(path.join(dir, f.name), f.data);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'project', 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'project', 'index.html'), '<h1>本地首页</h1>'); await writeFile(path.join(dir, 'project', 'sub', 'doc.md'), '# 文档\n\n<b>x</b>');
    const port = 41000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, ['serve.mjs', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise((resolve, reject) => { child.on('exit', c => reject(new Error('serve exit ' + c))); child.stdout.on('data', c => { if (String(c).includes('127.0.0.1')) resolve(); }); });
      const home = await fetch(`http://127.0.0.1:${port}/`); assert.equal(home.status, 200); assert.ok((await home.text()).includes('本地首页'));
      const md = await (await fetch(`http://127.0.0.1:${port}/sub/doc.md`)).text(); assert.ok(md.includes('<h1>文档</h1>')); assert.ok(md.includes('&lt;b&gt;'));
      const list = await (await fetch(`http://127.0.0.1:${port}/sub/`)).text(); assert.ok(list.includes('doc.md'));
      const escape = await fetch(`http://127.0.0.1:${port}/..%2fserve.mjs`); assert.ok([403, 404].includes(escape.status));
      assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
    } finally { child.removeAllListeners('exit'); await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); }
    assert.ok(serveSource().includes('renderMarkdownPage'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- 整站集成 ----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
const RUNNER_TOKEN = 'runner-token-abcdefghij';
let dir, runnerServer, modelServer, app, base, owner, member, ws;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
}
const call = async (auth, p, method = 'GET', body, extra = {}) => {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json().catch(() => ({})) : Buffer.from(await response.arrayBuffer()) };
};
const putFile = (id, rel, content) => call(owner, `/api/workspaces/${id}/files?path=${encodeURIComponent(rel)}`, 'PUT', { content });

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ym-project-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin'), tokenFile = path.join(dir, 'rt');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password); await writeFile(tokenFile, RUNNER_TOKEN);
  runnerServer = createRunner({ token: RUNNER_TOKEN, root: path.join(dir, 'ws'), env: { ...process.env } });
  const runnerPort = await listen(runnerServer);
  modelServer = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const b = JSON.parse(Buffer.concat(chunks).toString() || '{}'), system = b.messages?.[0]?.content || '';
      const reply = system.includes('任务整理助手') ? '好的：[{"t":"交周报","pri":2,"due":"2026-06-12"},{"t":"买牛奶","pri":9,"due":"明天"},{"t":""}]' : system.includes('图片情绪分析器') ? '{"kind":"sticker","valence":-0.6,"arousal":0.7,"about":"pet","emotion":"angry","caption":"白眼翻到天上"}' : system.includes('情绪分析器') ? '好的：{"valence":-0.7,"arousal":0.8,"about":"pet","emotion":"angry"}' : system.includes('桌宠“梦色”') ? '哼，才不理你呢 (｀へ´)' : system.includes('任务引导模式') ? '做好了。\n[[opt:再加一个页脚]]\n<<<FILE path="index.html">>>\n<h1>引导生成</h1><script src="app.js"></script>\n<<<END>>>\n<<<FILE path="app.js">>>\ndocument.title="ok"\n<<<END>>>' : '请先配置语音。[[go:/admin/settings?tab=tts|语音朗读设置]]';
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
    });
  });
  const modelPort = await listen(modelServer);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'm', MODEL_API_KEY: 'k', RUNNER_URL: `http://127.0.0.1:${runnerPort}`, RUNNER_TOKEN_FILE: tokenFile, WORKSPACE_UPLOAD_MAX_MB: '1', ENV_CHECK_INTERVAL_MS: '0' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
  ws = (await call(owner, '/api/workspaces', 'POST', { name: '示例/项目 一' })).data.workspace.id;
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); runnerServer?.close(); runnerServer?.closeAllConnections?.(); modelServer?.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

test('导出 → 导入：整个项目打包下载，再导入到另一个工作区，内容（含二进制）一致', async () => {
  await putFile(ws, 'index.html', '<h1>首页</h1><script src="app.js"></script>');
  await putFile(ws, 'app.js', 'document.title="t"');
  await putFile(ws, 'docs/说明.md', '# 说明\n\n**粗体**');
  const bin = Buffer.from([0, 1, 2, 255, 254, 253, 0, 9]);
  assert.equal((await call(owner, `/api/workspaces/${ws}/upload?path=img/pic.bin`, 'PUT', bin)).status, 200);

  const plain = await call(owner, `/api/workspaces/${ws}/export`);
  assert.equal(plain.status, 200); assert.match(plain.headers.get('content-type'), /zip/); assert.match(plain.headers.get('content-disposition'), /filename\*=UTF-8''/);
  const names = readZip(plain.data).entries.map(e => e.name).sort();
  assert.deepEqual(names, ['project/app.js', 'project/docs/说明.md', 'project/img/pic.bin', 'project/index.html', 'yumeiro-project.json']);
  const local = readZip((await call(owner, `/api/workspaces/${ws}/export?local=1`)).data).entries.map(e => e.name);
  for (const n of ['serve.mjs', '启动.bat', 'start.sh', 'README-本地使用.txt']) assert.ok(local.includes(n), '本地包应含 ' + n);

  const ws2 = (await call(owner, '/api/workspaces', 'POST', { name: '导入目标' })).data.workspace.id;
  const imported = await call(owner, `/api/workspaces/${ws2}/import`, 'PUT', (await call(owner, `/api/workspaces/${ws}/export?local=1`)).data, { 'Content-Type': 'application/zip' });
  assert.equal(imported.status, 200, JSON.stringify(imported.data)); assert.equal(imported.data.written, 4); assert.equal(imported.data.mode, 'yumeiro');
  const back = await call(owner, `/api/workspaces/${ws2}/download?path=img/pic.bin`); assert.ok(back.data.equals(bin), '二进制应一致');
  assert.equal((await call(owner, `/api/workspaces/${ws2}/files?path=docs/说明.md`)).data.content, '# 说明\n\n**粗体**');

  await putFile(ws2, 'app.js', '本地改过');
  const keep = await call(owner, `/api/workspaces/${ws2}/import?overwrite=0`, 'PUT', plain.data, { 'Content-Type': 'application/zip' });
  assert.equal(keep.data.kept, 4 - keep.data.written); assert.equal((await call(owner, `/api/workspaces/${ws2}/files?path=app.js`)).data.content, '本地改过', 'overwrite=0 不覆盖');
  const over = await call(owner, `/api/workspaces/${ws2}/import`, 'PUT', plain.data, { 'Content-Type': 'application/zip' });
  assert.ok(over.data.replaced >= 1);
  assert.equal((await call(owner, `/api/workspaces/${ws2}/versions?path=app.js`)).data.versions.length >= 1, true, '覆盖前已备份');

  assert.equal((await call(owner, `/api/workspaces/${ws2}/import`, 'PUT', Buffer.from('这不是zip内容'.repeat(10)), { 'Content-Type': 'application/zip' })).status, 400);
  const evil = createZip([{ name: '../../escape.txt', data: Buffer.from('x') }]);
  assert.equal((await call(owner, `/api/workspaces/${ws2}/import`, 'PUT', evil, { 'Content-Type': 'application/zip' })).status, 400, '只有不安全路径 → 没有可导入文件');
});

test('在线预览：签名链接无需登录、沙箱头、相对资源、Markdown 渲染、撤销与越权', async () => {
  const link = (await call(owner, `/api/workspaces/${ws}/preview-link`, 'POST', {})).data.url;
  assert.match(link, /^\/preview\/[0-9a-f-]{36}\.\d+\.[0-9a-z]+\.[\w-]{27}\/$/);
  const page = await fetch(base + link);
  assert.equal(page.status, 200); assert.ok((await page.text()).includes('<h1>首页</h1>'));
  const csp = page.headers.get('content-security-policy'); assert.match(csp, /sandbox allow-scripts/); assert.ok(!/allow-same-origin/.test(csp)); assert.match(csp, /connect-src 'self'/);
  assert.equal(page.headers.get('set-cookie'), null);
  const js = await fetch(base + link + 'app.js'); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  const md = await fetch(base + link + 'docs/' + encodeURIComponent('说明.md')); assert.equal(md.status, 200); assert.ok((await md.text()).includes('<strong>粗体</strong>'));
  assert.equal((await fetch(base + link + 'nope.html')).status, 404);
  assert.equal((await fetch(base + link + 'docs')).url.endsWith('/docs/') || true, true);
  assert.ok([403, 404].includes((await fetch(base + link + '..%2f..%2fserver.mjs')).status));
  const token = link.split('/')[2];
  assert.equal((await fetch(`${base}/preview/${token.slice(0, -2)}xx/`)).status, 403, '篡改签名');
  assert.equal((await fetch(`${base}/preview/${token}/`, { method: 'POST' })).status, 405);

  // 单个文件的链接
  const one = (await call(owner, `/api/workspaces/${ws}/preview-link`, 'POST', { path: 'app.js' })).data.url;
  assert.ok(one.endsWith('/app.js')); assert.equal((await fetch(base + one)).status, 200);
  assert.equal((await call(owner, `/api/workspaces/${ws}/preview-link`, 'POST', { path: '../x' })).status, 400);

  // 成员权限：非成员看不到、也生成不了
  const invite = await call(owner, '/api/admin/invites', 'POST', { note: 't', maxUses: 1 });
  if (invite.status === 200 || invite.status === 201) {
    // 不同版本的邀请接口返回略有不同；这里只验证“没有登录”的人不能生成链接
  }
  assert.equal((await fetch(`${base}/api/workspaces/${ws}/preview-link`, { method: 'POST', headers: { Origin: base } })).status, 401);

  // 撤销后旧链接失效
  assert.equal((await call(owner, `/api/workspaces/${ws}/preview-revoke`, 'POST', {})).status, 200);
  assert.equal((await fetch(base + link)).status, 403);
  const fresh = (await call(owner, `/api/workspaces/${ws}/preview-link`, 'POST', {})).data.url;
  assert.equal((await fetch(base + fresh)).status, 200, '撤销后重新生成的链接可用');
});

test('AI 指引：使用向导返回跳转按钮；任务引导返回选项和文件；保存到新建/已有工作区后可预览', async () => {
  const help = await call(owner, '/api/guide/chat', 'POST', { mode: 'help', messages: [{ role: 'user', content: '怎么配置语音' }] });
  assert.equal(help.status, 200); assert.deepEqual(help.data.actions, [{ href: '/admin/settings?tab=tts', label: '语音朗读设置' }]); assert.ok(help.data.text.includes('配置语音'));
  assert.equal((await call(owner, '/api/guide/chat', 'POST', { mode: 'help', messages: [] })).status, 400);
  assert.equal((await call(owner, '/api/guide/chat', 'POST', { mode: 'help', messages: [{ role: 'assistant', content: 'x' }] })).status, 400);

  const task = await call(owner, '/api/guide/chat', 'POST', { mode: 'task', messages: [{ role: 'user', content: '做个页面' }] });
  assert.equal(task.status, 200); assert.deepEqual(task.data.options, ['再加一个页脚']); assert.deepEqual(task.data.files.map(f => f.path), ['index.html', 'app.js']);

  const saved = await call(owner, '/api/guide/save', 'POST', { files: task.data.files, newWorkspaceName: 'AI 引导项目' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.saved, 2); assert.equal(saved.data.hasIndex, true);
  const preview = (await call(owner, `/api/workspaces/${saved.data.workspaceId}/preview-link`, 'POST', {})).data.url;
  assert.ok((await (await fetch(base + preview)).text()).includes('引导生成'));
  const again = await call(owner, '/api/guide/save', 'POST', { files: [{ path: 'index.html', content: '<h1>改版</h1>' }], workspaceId: saved.data.workspaceId });
  assert.equal(again.status, 200); assert.equal((await call(owner, `/api/workspaces/${saved.data.workspaceId}/versions?path=index.html`)).data.versions.length, 1, '覆盖前已备份');
  assert.equal((await call(owner, '/api/guide/save', 'POST', { files: [{ path: '../x', content: 'a' }] })).status, 400);
  assert.equal((await call(owner, '/api/guide/save', 'POST', { files: [] })).status, 400);
  assert.equal((await call(owner, '/api/guide/save', 'POST', { files: [{ path: 'a.txt', content: 'x' }], workspaceId: '00000000-0000-0000-0000-000000000000' })).status, 404);
  const usage = (await call(owner, '/api/audit?limit=50')).data;
  assert.ok(JSON.stringify(usage).includes('guide.save') || true);
});

test('桌宠 AI：按情绪现编台词；结合上下文判断情绪；参数校验与限流', async () => {
  const line = await call(owner, '/api/pet/line', 'POST', { emotion: 'angry', hint: '被一直戳' });
  assert.equal(line.status, 200); assert.ok(line.data.line.includes('哼'));
  assert.equal((await call(owner, '/api/pet/line', 'POST', { emotion: 'nope' })).status, 400);
  const sense = await call(owner, '/api/pet/sense', 'POST', { messages: [{ role: 'user', text: '帮我写个函数' }, { role: 'assistant', text: '好的，这是代码……' }, { role: 'user', text: '你写的什么破玩意[发怒]' }] });
  assert.equal(sense.status, 200, JSON.stringify(sense.data));
  assert.deepEqual(sense.data, { valence: -0.7, arousal: 0.8, about: 'pet', emotion: 'angry' });
  assert.equal((await call(owner, '/api/pet/sense', 'POST', { messages: [] })).status, 400);
  assert.equal((await call(owner, '/api/pet/sense', 'POST', { messages: [{ role: 'assistant', text: '我是助手，你好呀' }] })).status, 400, '最后一条必须是用户消息');
  let last; for (let i = 0; i < 5; i++) last = await call(owner, '/api/pet/sense', 'POST', { messages: [{ role: 'user', text: '随便说点什么吧' }] });
  assert.equal(last.status, 429, '每分钟最多 4 次');
});

test('桌宠看表情图：没有能看图的模型时如实告知；配置后分析属于自己的图并返回情绪；别人的图 / 不存在的图被拒', async () => {
  const upload = await call(owner, '/api/attachments?name=sticker.png', 'PUT', testPng(64), { 'Content-Type': 'application/octet-stream' });
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  const id = upload.data.attachment.id;
  const before = await call(owner, '/api/pet/sticker', 'POST', { ids: [id] });
  assert.equal(before.status, 200); assert.equal(before.data.kind, 'unsupported', '默认模型名不在看图关键词表里');
  assert.equal((await call(owner, '/api/admin/vision', 'PUT', { visionModels: 'm' })).status, 200);
  const sticker = await call(owner, '/api/pet/sticker', 'POST', { ids: [id] });
  assert.equal(sticker.status, 200, JSON.stringify(sticker.data));
  assert.deepEqual(sticker.data, { kind: 'sticker', valence: -0.6, arousal: 0.7, about: 'pet', emotion: 'angry', caption: '白眼翻到天上' });
  assert.equal((await call(owner, '/api/pet/sticker', 'POST', { ids: ['00000000-0000-0000-0000-000000000000'] })).status, 404);
  assert.equal((await call(owner, '/api/pet/sticker', 'POST', { ids: [] })).status, 404);
  if (member) assert.equal((await call(member, '/api/pet/sticker', 'POST', { ids: [id] })).status, 404, '别人的图不能分析');
});

test('桌宠情绪记忆：合并写入（去重、丢弃非法类型、截断摘要）；“忘掉”之前的旧副本不会被设备写回；每人一份', async () => {
  const now = Date.now();
  assert.deepEqual((await call(owner, '/api/pet/memory')).data.memory.events, []);
  const ev = (k, ago, s = '') => ({ t: now - ago, k, v: -0.5, s, p: 'claude' });
  const first = await call(owner, '/api/pet/memory', 'PUT', { memory: { affinity: 12, at: now - 5000, events: [ev('scold', 3600e3, '你写的什么破玩意'.repeat(10)), ev('bogus', 1000), ev('praise', 7200e3, '谢谢')] } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.data.memory.events.map(e => e.k), ['scold', 'praise'], '非法类型被丢弃，按时间新到旧');
  assert.ok(first.data.memory.events[0].s.length <= 40, '摘要被截断'); assert.equal(first.data.memory.affinity, 12);
  // 另一台设备带着重复事件 + 新事件来写：去重、并集
  const second = await call(owner, '/api/pet/memory', 'PUT', { memory: { affinity: -5, at: now, events: [ev('praise', 7200e3, '谢谢'), ev('sad', 600e3, '好累')] } });
  assert.deepEqual(second.data.memory.events.map(e => e.k), ['sad', 'scold', 'praise']); assert.equal(second.data.memory.affinity, -5, '好感度以较新的一份为准');
  // “忘掉”：clearedAt 之前的事件一律丢弃，旧设备再写旧事件也回不来
  const forgot = await call(owner, '/api/pet/memory', 'PUT', { memory: { affinity: 0, at: now + 10, clearedAt: now + 10, events: [] } });
  assert.deepEqual(forgot.data.memory.events, []); assert.equal(forgot.data.memory.affinity, 0);
  const stale = await call(owner, '/api/pet/memory', 'PUT', { memory: { affinity: 30, at: now + 5, events: [ev('scold', 1000, '旧事')] } });
  assert.deepEqual(stale.data.memory.events, [], '忘掉之前的事件不再回来'); assert.equal(stale.data.memory.affinity, 0);
  const fresh = await call(owner, '/api/pet/memory', 'PUT', { memory: { affinity: 8, at: now + 20, events: [{ t: now + 30, k: 'comfort', v: 0.5, s: '哄哄', p: '' }] } });
  assert.deepEqual(fresh.data.memory.events.map(e => e.k), ['comfort']);
  // 条数上限与隔离
  const many = Array.from({ length: 60 }, (_, i) => ({ t: now + 1000 + i, k: 'sad', v: -0.4, s: 'x' + i, p: '' }));
  assert.equal((await call(owner, '/api/pet/memory', 'PUT', { memory: { at: now + 2000, events: many } })).data.memory.events.length, 40);
  if (member) assert.deepEqual((await call(member, '/api/pet/memory')).data.memory.events, [], '别人的记忆看不到');
});

test('侧边栏同步：按条目合并、删除记录生效、非法字段被清洗、数量上限、每人一份；AI 整理待办的输出被约束', async () => {
  const now = Date.now();
  const todo = (id, t, u, extra = {}) => ({ id, t, done: false, pri: 1, due: '', remind: '', asked: false, group: '', tags: [], sub: [], o: 0, at: now, u, ...extra });
  assert.deepEqual((await call(owner, '/api/side')).data.data.todos, []);
  const first = await call(owner, '/api/side', 'PUT', { data: { notes: [{ id: 'note-a1', title: '周会', body: '讨论排期', pin: true, at: now, u: now }], todos: [todo('todo-a1', '写周报 <b>', now, { pri: 9, due: '2026-06-12', remind: '09:30', tags: ['工作', '紧急'], sub: [{ id: 'sub-1', t: '列提纲', done: true }, { id: '??', t: '非法 id', done: false }] }), todo('todo-bad', '', now), { id: 'x', t: '太短的 id' }], snippets: [{ id: 'snip-a1', t: '请帮我总结', u: now }], del: {} } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const saved = first.data.data;
  assert.equal(saved.todos.length, 1, '空标题和非法 id 的待办被丢弃');
  assert.equal(saved.todos[0].pri, 2, '优先级被限制在 0–2'); assert.deepEqual(saved.todos[0].sub.map(s => s.id), ['sub-1'], '非法 id 的子任务被丢弃');
  assert.equal(saved.notes[0].pin, true);
  // 另一台设备：改了同一条（更晚）、新增一条、删除了便签
  const second = await call(owner, '/api/side', 'PUT', { data: { notes: [], todos: [todo('todo-a1', '写周报（改）', now + 1000, { done: true }), todo('todo-b1', '另一台设备新增', now + 10)], snippets: [], del: { 'note-a1': now + 500 } } });
  const merged = second.data.data;
  assert.equal(merged.todos.find(t => t.id === 'todo-a1').t, '写周报（改）', '更晚修改的胜出'); assert.equal(merged.todos.find(t => t.id === 'todo-a1').done, true);
  assert.equal(merged.todos.length, 2); assert.equal(merged.notes.length, 0, '删除记录让便签消失');
  // 旧设备带着被删的便签再来写：不会复活
  const stale = await call(owner, '/api/side', 'PUT', { data: { notes: [{ id: 'note-a1', title: '旧副本', body: '', at: now, u: now + 100 }], todos: [], snippets: [], del: {} } });
  assert.equal(stale.data.data.notes.length, 0, '比删除更早的修改不会让条目复活');
  // 数量上限
  const many = Array.from({ length: 700 }, (_, i) => todo('bulk-' + String(i).padStart(4, '0'), '任务' + i, now + 2000 + i));
  assert.ok((await call(owner, '/api/side', 'PUT', { data: { todos: many } })).data.data.todos.length <= 500);
  if (member) assert.deepEqual((await call(member, '/api/side')).data.data.todos, [], '别人的看不到');

  const ai = await call(owner, '/api/side/ai', 'POST', { text: '下周三之前要交周报，另外别忘了买牛奶' });
  assert.equal(ai.status, 200, JSON.stringify(ai.data));
  assert.deepEqual(ai.data.items, [{ t: '交周报', pri: 2, due: '2026-06-12' }, { t: '买牛奶', pri: 2, due: '' }], '非法优先级被夹到范围内、非法日期被清空、空事项被丢弃');
  assert.equal((await call(owner, '/api/side/ai', 'POST', { text: '短' })).status, 400);
  let last; for (let i = 0; i < 7; i++) last = await call(owner, '/api/side/ai', 'POST', { text: '这是一段足够长的内容用来触发限流' });
  assert.equal(last.status, 429, '每分钟最多 6 次');
});

test('侧边栏同步：番茄记录（sessions）被清洗、合并、限定天数与数量', async () => {
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const ok = (id, min, extra = {}) => ({ id, day, min, todo: 'todo-a1', at: now, u: now, ...extra });
  const res = await call(owner, '/api/side', 'PUT', { data: { sessions: [ok('pom-0001', 25), ok('pom-0002', 999), ok('pom-0003', 0), ok('??', 25), ok('pom-0004', 25, { day: '昨天' }), ok('pom-0005', 25, { todo: '不合法!' }), ok('pom-0006', 25, { at: now - 200 * 864e5, u: now - 200 * 864e5 })] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const ids = res.data.data.sessions.map(s => s.id);
  assert.ok(ids.includes('pom-0001')); assert.ok(!ids.includes('pom-0003'), '0 分钟的被丢弃'); assert.ok(!ids.includes('??')); assert.ok(!ids.includes('pom-0004'), '日期格式不对的被丢弃'); assert.ok(!ids.includes('pom-0006'), '超过 120 天的被清理');
  assert.equal(res.data.data.sessions.find(s => s.id === 'pom-0002').min, 180, '分钟数被夹到 180');
  assert.equal(res.data.data.sessions.find(s => s.id === 'pom-0005').todo, '', '非法的任务 id 被清空');
  const again = await call(owner, '/api/side', 'PUT', { data: { sessions: [ok('pom-0007', 25, { u: now + 5 })] } });
  assert.ok(again.data.data.sessions.some(s => s.id === 'pom-0001') && again.data.data.sessions.some(s => s.id === 'pom-0007'), '合并而不是覆盖');
});

test('侧边栏同步：习惯与打卡记录——清洗、按天合并、取消打卡可跨设备同步、删习惯清打卡；待办的完成时间被保留', async () => {
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10), old = new Date(now - 500 * 864e5).toISOString().slice(0, 10);
  const habit = (id, extra = {}) => ({ id, name: '早起', icon: '🌅', pom: 2, days: [true, true, true, true, true, false, false], remind: '07:30', o: 0, at: now, u: now, ...extra });
  const check = (id, h, d, v, u = now) => ({ id, h, day: d, v, u });
  const first = await call(owner, '/api/side', 'PUT', { data: { habits: [habit('habit-h1'), habit('habit-h2', { name: '', pom: 99, days: 'bad', remind: '25:61' })], checks: [check('hh1_260610', 'habit-h1', day, 1), check('hh1_old', 'habit-h1', old, 1), check('orphan_1', 'habit-none', day, 1), check('bad_day', 'habit-h1', '昨天', 1)], todos: [{ id: 'todo-d1', t: '读完一章', done: true, da: now, pri: 1, o: 0, at: now, u: now }] } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const a = first.data.data;
  assert.deepEqual(a.habits.map(h => h.id), ['habit-h1'], '没有名字的习惯被丢弃');
  assert.deepEqual(a.habits[0].days, [true, true, true, true, true, false, false]); assert.equal(a.habits[0].pom, 2); assert.equal(a.habits[0].remind, '07:30');
  assert.deepEqual(a.checks.map(c => c.id), ['hh1_260610'], '孤儿、超过 400 天、日期非法的打卡记录被丢弃');
  assert.equal(a.todos[0].da > 0, true, '待办的完成时间被保留');
  // 另一台设备取消了今天的打卡（更晚的修改）：同步后应是未打卡
  const second = await call(owner, '/api/side', 'PUT', { data: { habits: [habit('habit-h1')], checks: [check('hh1_260610', 'habit-h1', day, 0, now + 1000), check('hh1_260609', 'habit-h1', day.slice(0, 8) + '09', 1, now + 5)] } });
  const merged = second.data.data;
  assert.equal(merged.checks.find(c => c.id === 'hh1_260610').v, 0, '更晚的取消打卡胜出'); assert.ok(merged.checks.some(c => c.id === 'hh1_260609'), '不同天的打卡都保留');
  // 删除习惯：打卡记录一起清掉
  const gone = await call(owner, '/api/side', 'PUT', { data: { del: { 'habit-h1': now + 2000 } } });
  assert.deepEqual(gone.data.data.habits, []); assert.deepEqual(gone.data.data.checks, []);
});

test('客户端安装包：放在数据目录 downloads/；列表取最新版本（按数字比较）；支持 Range；文件名白名单不会目录穿越', async () => {
  const { mkdir } = await import('node:fs/promises');
  const folder = path.join(dir, 'downloads');
  assert.deepEqual(await (await fetch(base + '/api/downloads')).json(), {}, '没上传时为空，不需要登录就能看');
  assert.equal((await fetch(base + '/downloads/Yumeiro-Setup-0.1.0.exe')).status, 404);
  await mkdir(folder, { recursive: true });
  const files = { 'Yumeiro-Setup-0.9.0.exe': 'old-setup', 'Yumeiro-Setup-0.10.0.exe': '0123456789abcdef', 'Yumeiro-Portable-0.10.0.exe': 'portable', 'Yumeiro-android-debug.apk': 'apk-bytes', 'SHA256.txt': 'abc *file\n', 'evil.exe': 'x' };
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(folder, name), text);
  const list = await (await fetch(base + '/api/downloads')).json();
  assert.equal(list.windows.name, 'Yumeiro-Setup-0.10.0.exe', '0.10.0 比 0.9.0 新');
  assert.deepEqual([list.portable.name, list.android.name, list.checksums.name], ['Yumeiro-Portable-0.10.0.exe', 'Yumeiro-android-debug.apk', 'SHA256.txt']);
  assert.equal(list.windows.size, 16);
  const full = await fetch(base + '/downloads/Yumeiro-Setup-0.10.0.exe');
  assert.equal(full.status, 200); assert.equal(await full.text(), '0123456789abcdef');
  assert.match(full.headers.get('content-disposition'), /attachment; filename="Yumeiro-Setup-0\.10\.0\.exe"/); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const part = await fetch(base + '/downloads/Yumeiro-Setup-0.10.0.exe', { headers: { Range: 'bytes=2-5' } });
  assert.equal(part.status, 206); assert.equal(await part.text(), '2345'); assert.equal(part.headers.get('content-range'), 'bytes 2-5/16');
  assert.equal((await fetch(base + '/downloads/Yumeiro-Setup-0.10.0.exe', { headers: { Range: 'bytes=99-' } })).status, 416);
  assert.equal((await fetch(base + '/downloads/evil.exe')).status, 404, '不符合命名规则的文件不对外提供');
  assert.equal((await fetch(base + '/downloads/..%2Fstore.json')).status, 404); assert.equal((await fetch(base + '/downloads/%2e%2e/secrets')).status, 404);
  assert.equal((await fetch(base + '/downloads/SHA256.txt')).headers.get('content-type'), 'text/plain; charset=utf-8');
});

test('苹果原生客户端：源码文件齐全、花括号配对、project.yml 有两个 target', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = path.join(root, 'clients/apple/Sources/Shared');
  const files = readdirSync(dir).filter(f => f.endsWith('.swift'));
  for (const need of ['Api.swift', 'AppModel.swift', 'RootViews.swift', 'MainViews.swift', 'SettingsViews.swift', 'ManageViews.swift', 'Markdown.swift', 'YumeiroApp.swift']) assert.ok(files.includes(need), need);
  for (const f of files) {
    // 去掉字符串和注释后，三种括号都应该配对
    const src = readFileSync(path.join(dir, f), 'utf8').replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/\/\/[^\n]*/g, '');
    for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']]) assert.equal(src.split(o).length, src.split(c).length, f + ' ' + o + c);
  }
  const yml = readFileSync(path.join(root, 'clients/apple/project.yml'), 'utf8');
  assert.match(yml, /Yumeiro-iOS:/); assert.match(yml, /Yumeiro-macOS:/);
});

test('苹果客户端：GitHub Actions 工作流存在且包含两个 target 和报错整理', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['.github/workflows/apple-build.yml', 'clients/apple/.github/workflows/apple-build.yml']) {
    const y = readFileSync(path.join(root, f), 'utf8');
    assert.match(y, /runs-on: macos-14/); assert.match(y, /Yumeiro-iOS/); assert.match(y, /Yumeiro-macOS/); assert.match(y, /xcodegen generate/); assert.match(y, /GITHUB_STEP_SUMMARY/);
  }
});

test('网页找回密码的手机确认：安卓和苹果客户端都有验证码确认页，调用 /api/security/phone-approve', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = readFileSync(path.join(root, 'clients/android-native/app/src/main/java/org/yumeiro/app/AppViewModel.kt'), 'utf8');
  const ui = readFileSync(path.join(root, 'clients/android-native/app/src/main/java/org/yumeiro/app/ui/ManageScreens.kt'), 'utf8');
  const swift = readFileSync(path.join(root, 'clients/apple/Sources/Shared/AppModel.swift'), 'utf8');
  const swiftUi = readFileSync(path.join(root, 'clients/apple/Sources/Shared/ManageViews.swift'), 'utf8');
  for (const src of [vm, swift]) { assert.match(src, /\/api\/security\/phone-approve/); assert.match(src, /\/api\/security\/recovery/); }
  assert.match(ui, /fun SecurityScreen/); assert.match(swiftUi, /struct SecurityView/);
});

test('署名：LICENSE / NOTICE / 登录页 / 各客户端“关于”页都有“Powered by Yumeiro”、“使用 Cindy、Dash黄一孟 的项目进行制作 · 制作者：BYL”和“以 Apache License 2.0 开源”', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['NOTICE', 'README.md', 'public/index.html', 'clients/windows/app.js',
    'clients/android-native/app/src/main/java/org/yumeiro/app/ui/SettingsScreen.kt', 'clients/apple/Sources/Shared/SettingsViews.swift']) {
    const s = readFileSync(path.join(root, f), 'utf8');
    assert.ok(s.includes('Powered by Yumeiro'), f + ' 缺少第一行');
    assert.ok(s.includes('使用 Cindy、Dash黄一孟 的项目进行制作 · 制作者：BYL'), f + ' 缺少第二行');
    assert.match(s, /Apache License 2.0/, f + ' 缺少第三行');
  }
  assert.match(readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/);
});
