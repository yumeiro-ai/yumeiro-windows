import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isVisionModel, visionRoute, normalizeVisionConfig, defaultVisionConfig, parseVisionResponse, buildVisionRequest, testPng, describedText, imageParts, pickPath, visionEndpoint } from '../vision.mjs';
import { sniffImage } from '../images.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('能否看图：关键词匹配 / 路由选择', () => {
  const config = { ...defaultVisionConfig(), enabled: true, baseUrl: 'http://x', visionModels: 'gpt-4o, -vl, llava' };
  assert.equal(isVisionModel('GPT-4o-mini', config.visionModels), true); assert.equal(isVisionModel('qwen2.5-vl-7b', config.visionModels), true); assert.equal(isVisionModel('deepseek-chat', config.visionModels), false);
  assert.equal(visionRoute(config, 'gpt-4o'), 'direct'); assert.equal(visionRoute(config, 'deepseek-chat'), 'service');
  assert.equal(visionRoute({ ...config, mode: 'service' }, 'gpt-4o'), 'service');
  assert.equal(visionRoute({ ...config, enabled: false }, 'deepseek-chat'), 'none'); assert.equal(visionRoute({ ...config, enabled: false }, 'gpt-4o'), 'direct');
});

test('识图配置：校验、保留旧密钥、启用前必须填地址和模型', () => {
  assert.throws(() => normalizeVisionConfig({ enabled: true }), /服务地址/);
  assert.throws(() => normalizeVisionConfig({ enabled: true, baseUrl: 'http://127.0.0.1:11434/v1' }), /模型名称/);
  assert.throws(() => normalizeVisionConfig({ baseUrl: 'ftp://x' }), /http/);
  assert.throws(() => normalizeVisionConfig({ textPath: 'a;b' }), /字段路径/);
  const a = normalizeVisionConfig({ enabled: true, baseUrl: 'http://127.0.0.1:11434/v1/', model: 'llava', apiKey: 'secret-key-1234', maxImages: 99, timeoutSec: 1 });
  assert.equal(a.baseUrl, 'http://127.0.0.1:11434/v1'); assert.equal(a.maxImages, 4); assert.equal(a.timeoutSec, 5);
  const b = normalizeVisionConfig({ model: 'other' }, a); assert.equal(b.apiKey, 'secret-key-1234'); assert.equal(b.model, 'other');
  assert.equal(normalizeVisionConfig({ clearKey: true }, a).apiKey, '');
});

test('请求与响应：openai 视觉模型 / http-ocr 各种返回格式', () => {
  const png = testPng(); assert.equal(sniffImage(png).mime, 'image/png'); assert.ok(png.length > 100);
  const openai = { ...defaultVisionConfig(), baseUrl: 'http://127.0.0.1:11434/v1', model: 'llava', apiKey: 'k' };
  const req = buildVisionRequest(openai, { buffer: png, mime: 'image/png' });
  assert.equal(req.url, 'http://127.0.0.1:11434/v1/chat/completions'); assert.equal(req.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(req.init.body); assert.equal(body.model, 'llava'); assert.equal(body.messages[0].content[1].image_url.url.startsWith('data:image/png;base64,'), true);
  assert.equal(visionEndpoint('http://a/v1/chat/completions'), 'http://a/v1/chat/completions');
  assert.deepEqual(parseVisionResponse(openai, { choices: [{ message: { content: ' 一只猫 ' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { text: '一只猫', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
  assert.equal(parseVisionResponse(openai, { choices: [{ message: { content: [{ type: 'text', text: '多段' }, { type: 'text', text: '内容' }] } }] }).text, '多段内容');
  const ocr = { ...defaultVisionConfig(), dialect: 'http-ocr', baseUrl: 'http://127.0.0.1:8000/ocr', textPath: 'data.lines' };
  const form = buildVisionRequest(ocr, { buffer: png, mime: 'image/png' }); assert.ok(form.init.body instanceof FormData); assert.equal(form.url, 'http://127.0.0.1:8000/ocr');
  assert.equal(parseVisionResponse(ocr, { data: { lines: ['第一行', '第二行'] } }).text, '第一行\n第二行');
  assert.equal(parseVisionResponse(ocr, { data: { lines: [{ text: 'A' }, { text: 'B' }] } }).text, 'A\nB');
  assert.equal(parseVisionResponse({ ...ocr, textPath: 'nope' }, { text: '回退字段' }).text, '回退字段');
  assert.equal(parseVisionResponse(ocr, {}).text, '');
  assert.equal(pickPath({ a: [{ b: 1 }] }, 'a[0].b'), 1);
  assert.equal(describedText('问题', ['描述A', '描述B']), '问题\n\n[图片 1 识别结果]\n描述A\n\n[图片 2 识别结果]\n描述B');
  assert.equal(imageParts('', [{ url: 'u' }]).length, 2);
});

// ---------- 整站集成 ----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, app, base, owner, modelServer, visionServer, ocrServer, visionPort, ocrPort;
const modelCalls = [], visionCalls = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const readBody = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
}
const call = async (auth, p, method = 'GET', body, extra = {}) => {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json().catch(() => ({})) : Buffer.from(await response.arrayBuffer()) };
};
const chat = async (conversationId, message, attachments) => call(owner, '/api/chat', 'POST', { conversation_id: conversationId, message, ...(attachments ? { attachments } : {}) });
const newConversation = async (model) => (await call(owner, '/api/conversations', 'POST', model ? { model } : {})).data.conversation.id;
const upload = async (buffer = testPng(), name = 'a.png') => call(owner, '/api/attachments?name=' + encodeURIComponent(name), 'PUT', buffer, { 'Content-Type': 'application/octet-stream' });

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ym-vision-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  modelServer = http.createServer(async (req, res) => { const b = JSON.parse((await readBody(req)).toString() || '{}'); modelCalls.push(b); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '收到' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } })); });
  visionServer = http.createServer(async (req, res) => { const b = JSON.parse((await readBody(req)).toString() || '{}'); visionCalls.push(b); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '图中是一只橘猫，旁边写着“Hello”' } }], usage: { prompt_tokens: 9, completion_tokens: 8 } })); });
  ocrServer = http.createServer(async (req, res) => { const buf = await readBody(req); visionCalls.push({ ocr: true, multipart: /multipart\/form-data/.test(req.headers['content-type'] || ''), bytes: buf.length }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: { text: '发票金额 128.00 元' } })); });
  const modelPort = await listen(modelServer); visionPort = await listen(visionServer); ocrPort = await listen(ocrServer);
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'deepseek-chat', MODEL_EXTRA_NAMES: 'gpt-4o', MODEL_API_KEY: 'k', ENV_CHECK_INTERVAL_MS: '0' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); for (const s of [modelServer, visionServer, ocrServer]) { s?.close(); s?.closeAllConnections?.(); } await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

test('上传附件：只收真图片、仅本人可看、可删除', async () => {
  assert.equal((await upload(Buffer.from('这不是图片，只是一段普通文字内容'))).status, 400);
  const up = await upload(); assert.equal(up.status, 201); const id = up.data.attachment.id;
  const got = await call(owner, '/api/attachments/' + id); assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.match(got.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await fetch(base + '/api/attachments/' + id)).status, 401);
  assert.equal((await call(owner, '/api/attachments/' + id, 'DELETE')).status, 200); assert.equal((await call(owner, '/api/attachments/' + id)).status, 404);
  const cfg = (await call(owner, '/api/vision/config')).data; assert.equal(cfg.serviceEnabled, false); assert.equal(cfg.maxImages, 4);
});

test('直接看图：模型名在关键词表里 → 图片作为 image_url 发给聊天模型', async () => {
  const conversation = await newConversation('gpt-4o');
  const att = (await upload()).data.attachment;
  modelCalls.length = 0;
  const r = await chat(conversation, '这是什么？', [att.id]); assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = modelCalls.at(-1).messages.at(-1);
  assert.equal(Array.isArray(sent.content), true); assert.equal(sent.content[0].text, '这是什么？'); assert.match(sent.content[1].image_url.url, /^data:image\/png;base64,/);
  const messages = (await call(owner, '/api/conversations/' + conversation)).data.messages; assert.equal(messages[0].images[0].id, att.id);
  assert.equal((await chat(conversation, '再问一句')).status, 200);
  const history = modelCalls.at(-1).messages.filter(m => m.role === 'user'); assert.equal(Array.isArray(history[0].content), true, '历史里最近的带图消息继续带图');
  assert.equal((await chat(conversation, '用别人的图', ['00000000-0000-0000-0000-000000000000'])).status, 400);
  assert.equal((await chat(await newConversation('gpt-4o'), '', [(await upload()).data.attachment.id])).status, 200, '只发图片不写字也行');
  assert.equal((await call(owner, '/api/conversations/' + conversation, 'DELETE')).status, 200);
  assert.equal((await call(owner, '/api/attachments/' + att.id)).status, 404, '删对话时一并删图');
});

test('不能看图的模型：没有识图服务时给出明确提示；接入本地视觉模型后先识图再回答', async () => {
  const plain = await newConversation('deepseek-chat');
  const att = (await upload()).data.attachment;
  const refused = await chat(plain, '看看', [att.id]); assert.equal(refused.status, 400); assert.match(refused.data.error, /不能直接看图/);

  const saved = await call(owner, '/api/admin/vision', 'PUT', { enabled: true, dialect: 'openai', baseUrl: `http://127.0.0.1:${visionPort}/v1`, model: 'llava', apiKey: 'secret-vision-key', visionModels: 'gpt-4o' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data)); assert.equal(saved.data.config.apiKey, undefined); assert.equal(saved.data.config.hasKey, true);
  const test1 = await call(owner, '/api/admin/vision/test', 'POST', {}); assert.equal(test1.data.ok, true, JSON.stringify(test1.data)); assert.match(test1.data.sample, /橘猫/);
  visionCalls.length = 0; modelCalls.length = 0;
  const ok = await chat(plain, '图里有什么？', [att.id]); assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(visionCalls.length, 1); assert.equal(visionCalls[0].model, 'llava');
  const sent = modelCalls.at(-1).messages.at(-1).content; assert.equal(typeof sent, 'string'); assert.match(sent, /图里有什么？/); assert.match(sent, /\[图片 1 识别结果\]/); assert.match(sent, /橘猫/);
  assert.equal((await chat(plain, '还有别的吗')).status, 200); assert.equal(visionCalls.length, 1, '识别结果已缓存，不重复识别');
  assert.equal((await call(owner, '/api/vision/config')).data.serviceEnabled, true);

  const forced = await call(owner, '/api/admin/vision', 'PUT', { mode: 'service' });
  assert.equal(forced.data.config.mode, 'service');
  const gptConversation = await newConversation('gpt-4o'); visionCalls.length = 0;
  assert.equal((await chat(gptConversation, '一律走服务', [(await upload()).data.attachment.id])).status, 200); assert.equal(visionCalls.length, 1);
  await call(owner, '/api/admin/vision', 'PUT', { mode: 'auto' });

  const ocr = await call(owner, '/api/admin/vision', 'PUT', { enabled: true, dialect: 'http-ocr', baseUrl: `http://127.0.0.1:${ocrPort}/ocr`, textPath: 'data.text' });
  assert.equal(ocr.status, 200); visionCalls.length = 0; modelCalls.length = 0;
  const invoice = await newConversation('deepseek-chat');
  assert.equal((await chat(invoice, '帮我读出金额', [(await upload()).data.attachment.id])).status, 200);
  assert.equal(visionCalls[0].ocr, true); assert.equal(visionCalls[0].multipart, true); assert.match(modelCalls.at(-1).messages.at(-1).content, /发票金额 128\.00 元/);

  assert.equal((await call(owner, '/api/admin/vision', 'PUT', { baseUrl: 'ftp://x' })).status, 400);
  assert.equal((await call(owner, '/api/admin/vision/test', 'POST', { baseUrl: 'http://127.0.0.1:1/v1', model: 'm' })).data.ok, false);
});

test('文件附件：文本类文件内容交给模型，其它格式拒绝，删除对话时一并清理', async () => {
  const text = '第一行：预算 100 元\n第二行：```代码围栏```';
  const up = await upload(Buffer.from(text, 'utf8'), 'notes.txt'); assert.equal(up.status, 201, JSON.stringify(up.data));
  const att = up.data.attachment; assert.equal(att.kind, 'doc'); assert.equal(att.name, 'notes.txt');
  const got = await call(owner, '/api/attachments/' + att.id); assert.equal(got.status, 200); assert.match(got.headers.get('content-type'), /^text\/plain/); assert.match(got.headers.get('content-security-policy'), /sandbox/);
  // 不接受：二进制扩展名、伪装成文本的二进制、不是 UTF-8 的内容
  assert.equal((await upload(Buffer.from('%PDF-1.4 fake'), 'a.pdf')).status, 400);
  assert.equal((await upload(Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]), 'bin.txt')).status, 400);
  assert.equal((await upload(Buffer.from([0xff, 0xfe, 0xfd, 0xfc]), 'gbk.txt')).status, 400);
  const conversation = await newConversation('deepseek-chat');
  modelCalls.length = 0;
  const r = await chat(conversation, '帮我看看这个文件', [att.id]); assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = modelCalls.at(-1).messages.at(-1);
  assert.equal(typeof sent.content, 'string'); assert.match(sent.content, /帮我看看这个文件/); assert.match(sent.content, /【附件：notes\.txt】/); assert.match(sent.content, /预算 100 元/);
  assert.ok(sent.content.includes('````'), '文件里自带 ``` 时围栏要加长');
  const messages = (await call(owner, '/api/conversations/' + conversation)).data.messages;
  assert.equal(messages[0].content, '帮我看看这个文件', '保存的消息保持用户原文，文件内容不重复存进对话');
  assert.equal(messages[0].files[0].id, att.id); assert.equal(messages[0].images, undefined);
  // 只发文件不写字：补默认提问；超过 5 个文件拒绝
  const second = (await upload(Buffer.from('a,b\n1,2'), 'data.csv')).data.attachment;
  assert.equal((await chat(await newConversation('deepseek-chat'), '', [second.id])).status, 200);
  assert.match(modelCalls.at(-1).messages.at(-1).content, /请阅读我上传的文件/);
  const many = []; for (let i = 0; i < 6; i++) many.push((await upload(Buffer.from('x' + i), 'f' + i + '.md')).data.attachment.id);
  assert.equal((await chat(await newConversation('deepseek-chat'), '太多了', many)).status, 400);
  // 更早的消息只留占位说明（最近 3 条带文件的才带内容）
  const history = await newConversation('deepseek-chat');
  const ids = []; for (let i = 0; i < 4; i++) ids.push((await upload(Buffer.from('内容' + i), 'h' + i + '.txt')).data.attachment.id);
  for (let i = 0; i < 4; i++) assert.equal((await chat(history, '第' + i + '条', [ids[i]])).status, 200);
  const sentUsers = modelCalls.at(-1).messages.filter(m => m.role === 'user').map(m => m.content);
  assert.match(sentUsers[0], /已省略/); assert.ok(!sentUsers[0].includes('内容0')); assert.match(sentUsers[3], /内容3/);
  assert.equal((await call(owner, '/api/conversations/' + conversation, 'DELETE')).status, 200);
  assert.equal((await call(owner, '/api/attachments/' + att.id)).status, 404);
  const cfg = (await call(owner, '/api/vision/config')).data; assert.equal(cfg.maxFiles, 5); assert.equal(cfg.maxDocKb, 8192);
  // 大文件：上传上限跟图片共用（默认 8 MB），交给模型的文字量有上限并标明已省略
  const big = (await upload(Buffer.from('大文件一行内容 '.repeat(200000), 'utf8'), 'big.log')); assert.equal(big.status, 201, JSON.stringify(big.data));
  modelCalls.length = 0;
  assert.equal((await chat(await newConversation('deepseek-chat'), '总结', [big.data.attachment.id])).status, 200);
  const bigSent = modelCalls.at(-1).messages.at(-1).content; assert.match(bigSent, /后面的内容已省略/); assert.ok(bigSent.length < 110000, '单个文件约 10 万字封顶，实际 ' + bigSent.length);
  assert.equal((await upload(Buffer.alloc(9 * 1048576, 97), 'toolarge.txt')).status, 413);
});

test('常见文件格式：PDF / Word / Excel / PowerPoint 上传后提取文字交给模型，解析失败给明确提示', async () => {
  const { docxFixture, xlsxFixture, pptxFixture, pdfFixture } = await import('./doc-fixtures.mjs');
  const word = (await upload(docxFixture(), '合同.docx')); assert.equal(word.status, 201, JSON.stringify(word.data));
  const sheet = (await upload(xlsxFixture(), '报表.xlsx')); assert.equal(sheet.status, 201, JSON.stringify(sheet.data));
  const slides = (await upload(pptxFixture(), '汇报.pptx')); assert.equal(slides.status, 201, JSON.stringify(slides.data));
  const pdf = (await upload(pdfFixture(['Invoice total 128 yuan']), '发票.pdf')); assert.equal(pdf.status, 201, JSON.stringify(pdf.data));
  assert.equal(word.data.attachment.name, '合同.docx'); assert.equal(word.data.attachment.kind, 'doc');
  // 保存的是提取出来的文字（点开标签看到的就是它）
  const viewed = await call(owner, '/api/attachments/' + sheet.data.attachment.id); assert.equal(viewed.status, 200); assert.match(viewed.headers.get('content-type'), /^text\/plain/);
  assert.match(viewed.data.toString('utf8'), /## 工作表：销售/);
  modelCalls.length = 0;
  const ids = [word, sheet, slides, pdf].map(item => item.data.attachment.id);
  const r = await chat(await newConversation('deepseek-chat'), '汇总这几份文件', ids); assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = modelCalls.at(-1).messages.at(-1).content;
  assert.match(sent, /【附件：合同\.docx】/); assert.match(sent, /你好 & 世界/);
  assert.match(sent, /【附件：报表\.xlsx】/); assert.match(sent, /苹果 & 梨\t42\tTRUE/);
  assert.match(sent, /【附件：汇报\.pptx】/); assert.match(sent, /## 幻灯片 2/);
  assert.match(sent, /【附件：发票\.pdf】/); assert.match(sent, /Invoice total 128 yuan/);
  // 失败时提示原因，而不是笼统的“不支持”
  const bad = await upload(Buffer.from('不是 zip'), '坏的.docx'); assert.equal(bad.status, 400); assert.match(bad.data.error, /无法打开这个文件/);
  const old = await upload(Buffer.from('x'), '旧的.doc'); assert.equal(old.status, 400); assert.match(old.data.error, /另存为 \.docx/);
  const scan = await upload(pdfFixture(['']), '扫描件.pdf'); assert.equal(scan.status, 400); assert.match(scan.data.error, /扫描件/);
  assert.equal((await upload(Buffer.from('MZ'), '程序.exe')).status, 400);
});
