import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { transcribe, silenceWav, normalizeAsrConfig, buildContext, langById, LANGS } from '../asr.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('silenceWav 是合法的 16kHz 单声道 WAV', () => {
  const wav = silenceWav(0.5);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.length, 44 + 8000 * 2);
});

test('方言提示词：方言写入提示，普通话要求简体，热词拼在后面', () => {
  assert.match(buildContext(langById('sichuan'), ''), /四川话/);
  assert.match(buildContext(langById('zh'), ''), /简体中文/);
  assert.equal(buildContext(langById('auto'), ''), '');
  assert.match(buildContext(langById('auto'), '星辰 设计组'), /星辰 设计组/);
  assert.equal(langById('不存在').id, 'auto');
  assert.ok(LANGS.filter(l => l.group === '方言').length >= 10);
});

test('配置校验：开启必须有服务商和模型；非法值被拒绝；未提交的字段沿用旧值', () => {
  const ok = id => id === 'p1';
  assert.throws(() => normalizeAsrConfig({ enabled: true }, {}, ok), /服务来源/);
  assert.throws(() => normalizeAsrConfig({ enabled: true, provider: 'nope', model: 'm' }, {}, ok), /不存在/);
  assert.throws(() => normalizeAsrConfig({ kind: 'x' }, {}, ok), /接口类型/);
  assert.throws(() => normalizeAsrConfig({ defaultLang: 'klingon' }, {}, ok), /默认语言/);
  assert.throws(() => normalizeAsrConfig({ maxSeconds: 999 }, {}, ok), /上限/);
  const first = normalizeAsrConfig({ enabled: true, provider: 'p1', model: 'whisper-1', hotwords: 'a'.repeat(900) }, {}, ok);
  assert.equal(first.hotwords.length, 500);
  const second = normalizeAsrConfig({ defaultLang: 'yue' }, first, ok);
  assert.equal(second.model, 'whisper-1'); assert.equal(second.defaultLang, 'yue'); assert.equal(second.enabled, true);
});

test('transcriptions：multipart 带 model / language / prompt；粤语用 yue；服务不认语言代码时去掉再试一次', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const form = init.body;
    calls.push({ url, auth: init.headers.Authorization, model: form.get('model'), language: form.get('language'), prompt: form.get('prompt'), file: form.get('file') });
    if (form.get('language') === 'yue' && calls.length === 1) return jsonResponse({ error: { message: 'unsupported language' } }, 400);
    return jsonResponse({ text: ' 你好 ' });
  };
  const audio = silenceWav();
  const text = await transcribe({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-1', kind: 'transcriptions', model: 'whisper-1', langId: 'yue', audio, hotwords: '星辰', fetchImpl });
  assert.equal(text, '你好');
  assert.equal(calls.length, 2, '400 之后重试一次');
  assert.equal(calls[0].url, 'https://api.example.com/v1/audio/transcriptions'); assert.equal(calls[0].auth, 'Bearer sk-1');
  assert.equal(calls[0].language, 'yue'); assert.equal(calls[1].language, null); assert.match(calls[1].prompt, /粤语.*星辰/);
  assert.equal(calls[0].file.name, 'speech.wav'); assert.equal(calls[0].model, 'whisper-1');
  // 四川话没有语言代码：不发 language，只靠提示词
  const forms = [];
  await transcribe({ baseUrl: 'https://api.example.com/v1/', kind: 'transcriptions', model: 'm', langId: 'sichuan', audio, fetchImpl: async (u, i) => { forms.push(i.body); return jsonResponse({ text: 'x' }); } });
  assert.equal(forms[0].get('language'), null); assert.match(forms[0].get('prompt'), /四川话/);
});

test('chat-audio：input_audio 用 data URL，asr_options 带语言，解析 choices 文本；错误信息不泄露密钥', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return jsonResponse({ choices: [{ message: { content: '今天天气不错' } }] }); };
  const text = await transcribe({ baseUrl: 'https://dashscope.example.com/compatible-mode/v1', apiKey: 'sk-secret', kind: 'chat-audio', model: 'qwen3-asr-flash', langId: 'yue', audio: silenceWav(), hotwords: '', fetchImpl });
  assert.equal(text, '今天天气不错'); assert.equal(sent.url, 'https://dashscope.example.com/compatible-mode/v1/chat/completions');
  assert.equal(sent.body.model, 'qwen3-asr-flash'); assert.equal(sent.body.asr_options.language, 'yue'); assert.equal(sent.body.stream, false);
  const audioPart = sent.body.messages.at(-1).content[0];
  assert.equal(audioPart.type, 'input_audio'); assert.match(audioPart.input_audio.data, /^data:audio\/wav;base64,UklGR/);
  assert.equal(sent.body.messages[0].role, 'system');
  // 自动识别：没有 language 也没有系统提示
  await transcribe({ baseUrl: 'https://x.example.com/v1', kind: 'chat-audio', model: 'm', langId: 'auto', audio: silenceWav(), fetchImpl });
  assert.equal(sent.body.asr_options.language, undefined); assert.equal(sent.body.messages.length, 1);
  // 上游 401：报成 502（不是让用户重新登录），消息里没有密钥
  await assert.rejects(transcribe({ baseUrl: 'https://x.example.com/v1', apiKey: 'sk-secret', kind: 'chat-audio', model: 'm', audio: silenceWav(), fetchImpl: async () => jsonResponse({ error: { message: 'bad key' } }, 401) }),
    error => error.status === 502 && /HTTP 401/.test(error.message) && !error.message.includes('sk-secret'));
  await assert.rejects(transcribe({ baseUrl: 'https://x.example.com/v1', kind: 'chat-audio', model: 'm', audio: silenceWav(), fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } }), /ECONNREFUSED/);
});

test('服务器：配置与权限、上传识别、格式与限流、成员读不到密钥', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cindy-asr-'));
  const keyFile = path.join(dir, 'k'); await writeFile(keyFile, randomBytes(32).toString('base64'));
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ url: req.url, auth: req.headers.authorization, text: body.toString('utf8') });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '我是四川人' }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const up = 'http://127.0.0.1:' + upstream.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: await mkdtemp(path.join(dir, 'd-')), COOKIE_SECURE: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.on('exit', c => reject(new Error('exit ' + c))); child.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const base = 'http://127.0.0.1:' + port;
  const login = async acc => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(acc) }); const d = await r.json(); return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: d.csrfToken }; };
  const call = async (auth, p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const upload = (auth, query, body, type = 'audio/wav') => fetch(base + '/api/asr' + query, { method: 'POST', headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'Content-Type': type }, body }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  try {
    const owner = await login(ADMIN);
    await call(owner, '/api/admin/members', 'POST', { email: 'asr-a@example.com', password: 'member-password-12345' });
    const member = await login({ email: 'asr-a@example.com', password: 'member-password-12345' });
    // 未开启：成员看到 enabled=false，上传 404
    assert.equal((await call(member, '/api/asr/config')).data.enabled, false);
    assert.equal((await upload(member, '', silenceWav())).status, 404);
    // 只有管理员能配置
    assert.equal((await call(member, '/api/admin/asr')).status, 403);
    assert.equal((await call(member, '/api/admin/asr', 'PUT', { enabled: true })).status, 403);
    // 接入服务商（内网 http 地址允许）
    const created = await call(owner, '/api/admin/providers', 'POST', { name: '语音服务', template: 'custom', baseUrl: up + '/v1', apiKey: 'sk-asr-secret-value', models: ['whisper-1'] });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const providerId = created.data.provider.id;
    // 校验
    assert.equal((await call(owner, '/api/admin/asr', 'PUT', { enabled: true, provider: providerId })).status, 400, '缺模型');
    assert.equal((await call(owner, '/api/admin/asr', 'PUT', { enabled: true, provider: 'nope', model: 'm' })).status, 400);
    // 测试连接（静音）
    const tested = await call(owner, '/api/admin/asr/test', 'POST', { provider: providerId, kind: 'transcriptions', model: 'whisper-1' });
    assert.equal(tested.data.ok, true, JSON.stringify(tested.data));
    assert.match(seen.at(-1).url, /\/v1\/audio\/transcriptions$/); assert.equal(seen.at(-1).auth, 'Bearer sk-asr-secret-value');
    // 保存并开启
    const saved = await call(owner, '/api/admin/asr', 'PUT', { enabled: true, provider: providerId, kind: 'transcriptions', model: 'whisper-1', defaultLang: 'sichuan', hotwords: '星辰', maxSeconds: 30 });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const cfg = (await call(member, '/api/asr/config')).data;
    assert.equal(cfg.enabled, true); assert.equal(cfg.defaultLang, 'sichuan'); assert.equal(cfg.maxSeconds, 30);
    assert.ok(cfg.languages.some(l => l.id === 'yue') && !JSON.stringify(cfg).includes('sk-asr') && !('model' in cfg));
    assert.equal(JSON.stringify((await call(owner, '/api/admin/asr')).data).includes('sk-asr-secret-value'), false);
    // 识别：默认语言（四川话）→ 提示词；显式 yue → language=yue
    const r1 = await upload(member, '', silenceWav(1));
    assert.equal(r1.status, 200, JSON.stringify(r1.data)); assert.equal(r1.data.text, '我是四川人'); assert.equal(r1.data.lang, 'sichuan');
    assert.match(seen.at(-1).text, /四川话/); assert.match(seen.at(-1).text, /星辰/);
    const r2 = await upload(member, '?lang=yue', silenceWav(1));
    assert.equal(r2.status, 200); assert.match(seen.at(-1).text, /name="language"\r\n\r\nyue/);
    // 非法语言 / 非音频类型 / 太小 / 太大
    assert.equal((await upload(member, '?lang=klingon', silenceWav(1))).status, 400);
    assert.equal((await upload(member, '', silenceWav(1), 'text/plain')).status, 415);
    assert.equal((await upload(member, '', Buffer.alloc(50))).status, 400);
    assert.equal((await upload(member, '', Buffer.alloc(6 * 1024 * 1024 + 10))).status, 413);
    // 未登录
    assert.equal((await fetch(base + '/api/asr', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: silenceWav() })).status, 401);
    // 限流：每分钟 30 次
    let limited = 0;
    for (let i = 0; i < 35; i++) if ((await upload(member, '', silenceWav(0.5))).status === 429) limited++;
    assert.ok(limited >= 1, '应触发限流');
    // 关闭后不可用
    await call(owner, '/api/admin/asr', 'PUT', { enabled: false });
    assert.equal((await call(member, '/api/asr/config')).data.enabled, false);
  } finally {
    child.removeAllListeners('exit'); child.kill(); upstream.close();
    await new Promise(r => setTimeout(r, 200)); await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('语言表：方言只作提示、外语带 ISO 代码，且每个 id 唯一', async () => {
  const { LANGS, PRESETS } = await import('../asr.mjs');
  const ids = LANGS.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['chaoshan', 'gan', 'xiang', 'fr', 'de', 'es', 'ru', 'ar', 'th', 'vi']) assert.ok(ids.includes(id), id);
  for (const l of LANGS.filter(x => x.group === '方言')) assert.ok(l.hint && (!l.code || l.id === 'yue'), l.id);
  for (const l of LANGS.filter(x => x.group === '其他语言')) assert.ok(l.code, l.id);
  assert.ok(PRESETS.filter(p => p.free).length >= 3);
});
