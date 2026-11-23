import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeTtsConfig, defaultTtsConfig, speakableText, cleanSpeechRequest, buildSpeechRequest, sniffAudio, parseMultipart, audioTypeOf } from '../tts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(300, 1)]);
const wavBytes = (seconds = 0.5) => { const n = Math.floor(16000 * seconds), buf = Buffer.alloc(44 + n * 2); buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40); return buf; };

// ---------- 纯函数 ----------
test('朗读配置：规范化与校验', () => {
  const ok = normalizeTtsConfig({ enabled: true, provider: 'custom', baseUrl: 'https://api.example.com/v1/', apiKey: 'k1', model: 'tts-1', voices: 'alloy, nova, onyx', defaultVoice: 'nova', speed: 1.2, maxChars: 500 });
  assert.equal(ok.baseUrl, 'https://api.example.com/v1'); assert.deepEqual(ok.voices, ['alloy', 'nova', 'onyx']); assert.equal(ok.defaultVoice, 'nova');
  assert.equal(normalizeTtsConfig({ model: 'x' }, ok).apiKey, 'k1', '密钥留空沿用旧的');
  assert.throws(() => normalizeTtsConfig({ enabled: true, provider: 'custom', baseUrl: 'https://a.b/v1' }), /模型/);
  assert.throws(() => normalizeTtsConfig({ enabled: true, provider: 'custom', model: 'm' }), /接口地址/);
  assert.throws(() => normalizeTtsConfig({ format: 'ogg' }), /音频格式/);
  assert.throws(() => normalizeTtsConfig({ voices: ' ' }), /音色/);
  assert.throws(() => normalizeTtsConfig({ defaultVoice: 'ghost' }), /默认音色/);
  assert.throws(() => normalizeTtsConfig({ speed: 3 }), /语速/);
  assert.throws(() => normalizeTtsConfig({ maxChars: 5 }), /50–4096/);
  assert.throws(() => normalizeTtsConfig({ extraParams: '{坏' }), /JSON/);
});

test('朗读文本清理与请求校验', () => {
  const cleaned = speakableText('# 标题\n**加粗**文字，[文档](https://x.com/a)和 https://y.com/b。\n```js\nconsole.log(1)\n```\n- 第一项\n1. 第二项\n`行内代码`');
  assert.doesNotMatch(cleaned, /[*#`]|https?:/); assert.match(cleaned, /标题。加粗文字，文档和 ?（链接）/); assert.match(cleaned, /已省略/); assert.match(cleaned, /第一项。第二项。行内代码/);
  assert.equal(speakableText('```a```', { readCode: true }), '');
  const config = { ...defaultTtsConfig(), model: 'm', maxChars: 50 };
  assert.throws(() => cleanSpeechRequest(config, { input: '   ' }), /没有可朗读/);
  assert.throws(() => cleanSpeechRequest(config, { input: '字'.repeat(51) }), /最多朗读 50/);
  const p = cleanSpeechRequest(config, { input: '你好', voice: 'unknown', speed: 9, response_format: 'wav' });
  assert.deepEqual(p, { text: '你好', voice: 'alloy', speed: 2, format: 'wav' });
  assert.equal(cleanSpeechRequest(config, { input: '你好', response_format: 'xyz' }).format, 'mp3');
  assert.equal(buildSpeechRequest({ ...config, extraParams: { model: 'hack', instructions: '温柔' } }, p).model, 'm', '额外参数不能覆盖模型');
});

test('音频头校验与 multipart 解析', () => {
  assert.equal(sniffAudio(MP3).mime, 'audio/mpeg'); assert.equal(sniffAudio(wavBytes()).mime, 'audio/wav');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)])).mime, 'audio/ogg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(20)])).mime, 'audio/mpeg');
  assert.equal(sniffAudio(Buffer.from('<html>not audio at all</html>')), null);
  const b = '----x1', CRLF = '\r\n';
  const body = Buffer.concat([Buffer.from(`--${b}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper-1${CRLF}--${b}${CRLF}Content-Disposition: form-data; name="file"; filename="a.mp3"${CRLF}Content-Type: audio/mpeg${CRLF}${CRLF}`), MP3, Buffer.from(`${CRLF}--${b}--${CRLF}`)]);
  const form = parseMultipart(body, `multipart/form-data; boundary=${b}`);
  assert.equal(form.fields.model, 'whisper-1'); assert.equal(form.files.length, 1); assert.deepEqual(form.files[0].data, MP3); assert.equal(audioTypeOf(form.files[0]), 'audio/mpeg');
  assert.equal(audioTypeOf({ type: 'application/octet-stream', filename: 'x.m4a' }), 'audio/mp4');
  assert.throws(() => parseMultipart(body, 'multipart/form-data'), /boundary/);
});

// ---------- 接口集成 ----------
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
let dir, mock, mockPort, app, base, owner, ttsCalls = [], asrCalls = 0;
test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ym-tts-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'a');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password);
  mock = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (req.url === '/v1/audio/speech') {
        const body = JSON.parse(raw.toString()); ttsCalls.push({ ...body, auth: req.headers.authorization });
        if (body.input.includes('ERR')) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'tts boom' } })); }
        if (body.input.includes('NOAUDIO')) { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end('this is definitely not an audio file'); }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(MP3);
      }
      if (req.url === '/v1/audio/transcriptions') { asrCalls++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ text: '识别出来的文字' })); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r)); mockPort = mock.address().port;
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, MODEL_NAME: 'chat', MODEL_API_KEY: 'k', ENV_CHECK_INTERVAL_MS: '0' } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('exit ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  owner = await login(ADMIN);
});
test.after(async () => { app?.removeAllListeners('exit'); app?.kill(); mock?.close(); await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); });
async function login(account) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(account) });
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrfToken };
}
async function call(auth, p, method = 'GET', body) {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers, type, data: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
const settings = (patch = {}) => ({ enabled: true, provider: 'custom', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'tts-key', model: 'tts-1', voices: 'alloy, nova', defaultVoice: 'alloy', format: 'mp3', speed: 1, dailyChars: 0, maxChars: 300, ...patch });

test('朗读：未开启时拒绝；管理员配置有校验、密钥不回显、成员不能改；测试可用', async () => {
  await call(owner, '/api/admin/members', 'POST', { email: 'm@example.com', password: 'member-password-12345' });
  const member = await login({ email: 'm@example.com', password: 'member-password-12345' });
  assert.equal((await call(owner, '/api/tts/config')).data.enabled, false);
  assert.equal((await call(owner, '/api/tts', 'POST', { text: '你好' })).status, 503);
  assert.equal((await call(member, '/api/admin/tts', 'PUT', settings())).status, 403);
  assert.equal((await call(owner, '/api/admin/tts', 'PUT', { enabled: true, provider: 'custom', baseUrl: 'https://x.example.com/v1' })).status, 400);
  const saved = await call(owner, '/api/admin/tts', 'PUT', settings());
  assert.equal(saved.status, 200); assert.equal(saved.data.config.hasKey, true); assert.doesNotMatch(JSON.stringify(saved.data), /tts-key/);
  const t = await call(owner, '/api/admin/tts/test', 'POST', {});
  assert.equal(t.data.ok, true); assert.equal(t.data.mime, 'audio/mpeg'); assert.equal(ttsCalls.at(-1).auth, 'Bearer tts-key');
  assert.equal((await call(owner, '/api/admin/tts/test', 'POST', { baseUrl: 'http://127.0.0.1:1/v1' })).data.ok, false);
  const cfg = (await call(owner, '/api/tts/config')).data;
  assert.equal(cfg.enabled, true); assert.deepEqual(cfg.voices, ['alloy', 'nova']);
});

test('朗读：合成、文本清理、音色回退、缓存不重复计费、异常结果被拒', async () => {
  ttsCalls = [];
  const text = '**你好**，请看 [文档](https://x.com/a)。```js\nx\n```';
  let r = await call(owner, '/api/tts', 'POST', { text, voice: 'nova', speed: 1.5 });
  assert.equal(r.status, 200); assert.equal(r.type, 'audio/mpeg'); assert.deepEqual(r.data, MP3); assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-tts-cached'), '0');
  const sent = ttsCalls[0];
  assert.doesNotMatch(sent.input, /[*`]|https?:/); assert.match(sent.input, /你好，请看 文档/); assert.equal(sent.voice, 'nova'); assert.equal(sent.speed, 1.5); assert.equal(sent.response_format, 'mp3'); assert.equal(sent.model, 'tts-1');
  const used = (await call(owner, '/api/tts/config')).data.usedToday;
  assert.ok(used > 0);
  r = await call(owner, '/api/tts', 'POST', { text, voice: 'nova', speed: 1.5 });
  assert.equal(r.headers.get('x-tts-cached'), '1'); assert.equal(ttsCalls.length, 1, '命中缓存，不再请求上游');
  assert.equal((await call(owner, '/api/tts/config')).data.usedToday, used, '缓存命中不计字数');

  r = await call(owner, '/api/tts', 'POST', { text: '换个音色', voice: 'ghost' });
  assert.equal(r.status, 200); assert.equal(ttsCalls.at(-1).voice, 'alloy', '未知音色回退默认');
  assert.equal((await call(owner, '/api/tts', 'POST', { text: '   ' })).status, 400);
  assert.equal((await call(owner, '/api/tts', 'POST', { text: '字'.repeat(301) })).status, 400);
  const err = await call(owner, '/api/tts', 'POST', { text: 'ERR 失败' });
  assert.equal(err.status, 502); assert.match(err.data.error, /tts boom/);
  const fake = await call(owner, '/api/tts', 'POST', { text: 'NOAUDIO' });
  assert.equal(fake.status, 502); assert.match(fake.data.error, /不是音频/);
  const audit = (await call(owner, '/api/audit?action=tts.speak&limit=50')).data.entries;
  assert.ok(audit.some(e => e.ok) && audit.some(e => !e.ok), '成功和失败都写审计');
});

test('朗读：每日字数限额；OpenAI 兼容 /v1/audio/speech', async () => {
  const member = await login({ email: 'm@example.com', password: 'member-password-12345' });
  await call(owner, '/api/admin/tts', 'PUT', settings({ dailyChars: 10 }));
  assert.equal((await call(member, '/api/tts', 'POST', { text: '一二三四五六' })).status, 200);
  const over = await call(member, '/api/tts', 'POST', { text: '七八九十一二' });
  assert.equal(over.status, 429); assert.match(over.data.error, /已用完/);
  await call(owner, '/api/admin/tts', 'PUT', settings({ dailyChars: 0 }));

  const token = (await call(owner, '/api/tokens', 'POST', { name: 'voice' })).data.token;
  const post = (body, auth = true) => fetch(base + '/v1/audio/speech', { method: 'POST', headers: { ...(auth ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const speech = await post({ model: 'ignored', input: '接口朗读一下', voice: 'nova', response_format: 'wav' });
  assert.equal(speech.status, 200); assert.deepEqual(Buffer.from(await speech.arrayBuffer()), MP3); assert.equal(ttsCalls.at(-1).response_format, 'wav'); assert.equal(ttsCalls.at(-1).model, 'tts-1');
  assert.equal((await post({ input: 'x' }, false)).status, 401);
  assert.equal((await post({ input: '' })).status, 400);
});

test('识别：OpenAI 兼容 /v1/audio/transcriptions（multipart 上传）', async () => {
  const token = (await call(owner, '/api/tokens', 'POST', { name: 'asr' })).data.token;
  const upload = (fields = {}, file = { name: 'a.wav', type: 'audio/wav', data: wavBytes() }) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (file) form.append('file', new Blob([file.data], { type: file.type }), file.name);
    return fetch(base + '/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  };
  assert.equal((await upload({ model: 'whisper-1' })).status, 503, '管理员没开识别时拒绝');
  const saved = await call(owner, '/api/admin/asr', 'PUT', { enabled: true, provider: 'custom', kind: 'transcriptions', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'asr-key', model: 'whisper-1' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  let r = await upload({ model: 'whisper-1', language: 'zh' });
  assert.equal(r.status, 200); assert.equal((await r.json()).text, '识别出来的文字'); assert.equal(asrCalls, 1);
  r = await upload({ response_format: 'text' });
  assert.equal(r.status, 200); assert.equal(await r.text(), '识别出来的文字');
  assert.equal((await upload({}, null)).status, 400, '缺 file');
  assert.equal((await upload({}, { name: 'a.txt', type: 'text/plain', data: Buffer.alloc(400, 65) })).status, 415);
  assert.equal((await fetch(base + '/v1/audio/transcriptions', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: '' })).status, 401);
});
